/* ─────────────────────────────────────────────
   Meal Planner — app.js
   ───────────────────────────────────────────── */

   const STORAGE_KEY = 'mealplanner_state';
   const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
   
   let tokenClient = null;
   let accessToken = null;
   let mealData = null;
   let checkedItems = {};
   let doneSteps = {};
   let ratings = {};
   let shoppingList = [];  // built at load time from meal ingredients
   
   /* ── Screen & View Management ── */
   
   function showScreen(id) {
     document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
     document.getElementById('screen-' + id).classList.add('active');
   }
   
   function showView(name) {
     document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
     document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
     document.getElementById('view-' + name).classList.add('active');
     document.querySelector(`.nav-btn[data-view="${name}"]`).classList.add('active');
   }
   
   function showError(msg) {
     document.getElementById('error-msg').textContent = msg;
     showScreen('error');
   }
   
   function showLoading(msg) {
     document.getElementById('loading-msg').textContent = msg || 'Loading...';
     showScreen('loading');
   }
   
   /* ── Shopping List Builder ── */
   
   function buildShoppingList(meals) {
     // Consolidate ingredients across all meals
     // Group by name + unit, sum amounts
     // Items with no unit (countable) are grouped by name only and counted
   
     const map = {};
   
     meals.forEach(meal => {
       (meal.ingredients || []).forEach(ing => {
         const key = ing.name.toLowerCase() + '|' + (ing.unit || 'COUNT');
         if (!map[key]) {
           map[key] = {
             name: ing.name,
             amount: 0,
             unit: ing.unit,
             used_in: []
           };
         }
         map[key].amount += ing.amount || 0;
         if (!map[key].used_in.includes(meal.id)) {
           map[key].used_in.push(meal.id);
         }
       });
     });
   
     // Assign categories (simple lookup — extend as needed)
     const categoryMap = {
       'chicken thighs': 'meat',
       'beef mince': 'meat',
       'lamb chops': 'meat',
       'bacon': 'meat',
       'pork': 'meat',
       'salmon': 'meat',
       'potatoes': 'produce',
       'zucchini': 'produce',
       'brown onion': 'produce',
       'green beans': 'produce',
       'garlic': 'produce',
       'rosemary': 'produce',
       'tomatoes': 'produce',
       'lemon': 'produce',
       'butter': 'dairy',
       'milk': 'dairy',
       'cream': 'dairy',
       'cheese': 'dairy',
       'eggs': 'dairy',
       'tinned crushed tomatoes': 'pantry',
       'penne pasta': 'pantry',
       'spaghetti': 'pantry',
       'olive oil': 'pantry',
       'dried oregano': 'pantry',
       'dried basil': 'pantry',
       'salt': 'pantry',
       'black pepper': 'pantry',
       'flour': 'pantry',
       'sugar': 'pantry',
     };
   
     return Object.values(map).map(item => ({
       ...item,
       category: categoryMap[item.name.toLowerCase()] || 'other',
       display: formatShoppingDisplay(item)
     }));
   }
   
   const COMPACT_UNITS = ['g', 'kg', 'ml', 'l'];
   
   function formatUnit(amount, unit) {
     if (!unit) return `${amount}x`;
     if (COMPACT_UNITS.includes(unit)) return `${amount}${unit}`;
     return `${amount} ${unit}`;
   }
   
   function formatShoppingDisplay(item) {
     if (!item.unit) {
       return item.amount > 1
         ? `${item.amount}x ${item.name}`
         : item.name;
     }
     return `${formatUnit(item.amount, item.unit)} ${item.name}`;
   }
   
   /* ── Local Storage ── */
   
   function loadState() {
     try {
       const raw = localStorage.getItem(STORAGE_KEY);
       if (!raw) return null;
       return JSON.parse(raw);
     } catch (e) {
       return null;
     }
   }
   
   function saveState() {
     const state = {
       generated: mealData?.generated,
       checkedItems,
       doneSteps,
       ratings
     };
     localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
   }
   
   function initState(generatedDate) {
     const saved = loadState();
     if (saved && saved.generated === generatedDate) {
       checkedItems = saved.checkedItems || {};
       doneSteps = saved.doneSteps || {};
       ratings = saved.ratings || {};
     } else {
       checkedItems = {};
       doneSteps = {};
       ratings = {};
       saveState();
     }
   }
   
   /* ── Google Auth ── */
   
   function initGoogle() {
     tokenClient = google.accounts.oauth2.initTokenClient({
       client_id: CONFIG.googleClientId,
       scope: DRIVE_SCOPE,
       callback: (response) => {
         if (response.error) {
           showError('Sign in failed: ' + response.error);
           return;
         }
         accessToken = response.access_token;
         loadMealsFromDrive();
       }
     });
   }
   
   function signIn() {
     tokenClient.requestAccessToken({ prompt: 'consent' });
   }
   
   /* ── Google Drive ── */
   
   async function driveGet(url) {
     const res = await fetch(url, {
       headers: { Authorization: 'Bearer ' + accessToken }
     });
     if (!res.ok) throw new Error('Drive request failed: ' + res.status);
     return res.json();
   }
   
   async function loadMealsFromDrive() {
     showLoading('Finding your meal plan...');
     try {
       const folderSearch = await driveGet(
         `https://www.googleapis.com/drive/v3/files?q=name='${CONFIG.driveFolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id,name)`
       );
   
       if (!folderSearch.files.length) {
         showError(`Couldn't find a folder called "${CONFIG.driveFolderName}" in your Drive.`);
         return;
       }
   
       const folderId = folderSearch.files[0].id;
   
       const fileSearch = await driveGet(
         `https://www.googleapis.com/drive/v3/files?q='${folderId}' in parents and name contains 'meals_' and mimeType='application/json' and trashed=false&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)&pageSize=1`
       );
   
       if (!fileSearch.files.length) {
         showError(`No meals file found in "${CONFIG.driveFolderName}".`);
         return;
       }
   
       const file = fileSearch.files[0];
       showLoading(`Loading ${file.name}...`);
   
       const contentRes = await fetch(
         `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
         { headers: { Authorization: 'Bearer ' + accessToken } }
       );
       if (!contentRes.ok) throw new Error('Could not download file');
   
       mealData = await contentRes.json();
       shoppingList = buildShoppingList(mealData.meals || []);
       initState(mealData.generated);
       renderApp();
       showScreen('app');
       showView('meals');
   
     } catch (err) {
       showError('Something went wrong: ' + err.message);
     }
   }
   
   /* ── Render: Meals View ── */
   
   function renderMeals() {
     const list = document.getElementById('meals-list');
   
     if (!mealData?.meals?.length) {
       list.innerHTML = '<div class="empty-state">No meals found.</div>';
       return;
     }
   
     const sorted = [...mealData.meals].sort((a, b) => new Date(a.date) - new Date(b.date));
   
     list.innerHTML = sorted.map(meal => {
       const rating = ratings[meal.id] || 0;
       const stars = [1,2,3,4,5].map(n =>
         `<span class="star ${n <= rating ? 'filled' : ''}" data-meal="${meal.id}" data-star="${n}">★</span>`
       ).join('');
   
       const statusBadge = meal.status !== 'planned'
         ? `<span class="meal-status ${meal.status}">${meal.status}</span>`
         : '';
   
       const lunchTag = meal.makes_lunch_tomorrow
         ? `<span class="meal-tag lunch">+ lunch tomorrow</span>`
         : '';
   
       return `
         <div class="meal-card" data-meal="${meal.id}">
           <div class="meal-night">${meal.night} · ${formatDate(meal.date)}</div>
           <div class="meal-name">${meal.name}</div>
           <div class="meal-desc">${meal.description}</div>
           <div class="meal-tags">${lunchTag}</div>
           ${statusBadge}
           <div class="meal-rating">${stars}</div>
         </div>
       `;
     }).join('');
   
     // Tap card → go to cook view for that meal
     list.querySelectorAll('.meal-card').forEach(card => {
       card.addEventListener('click', (e) => {
         // Don't trigger if tapping a star
         if (e.target.classList.contains('star')) return;
         showView('cook');
         renderCookSteps(card.dataset.meal);
       });
     });
   
     // Star ratings
     list.querySelectorAll('.star').forEach(star => {
       star.addEventListener('click', (e) => {
         e.stopPropagation();
         const mealId = star.dataset.meal;
         const val = parseInt(star.dataset.star);
         ratings[mealId] = ratings[mealId] === val ? 0 : val;
         saveState();
         renderMeals();
       });
     });
   }
   
   /* ── Render: Shopping View ── */
   
   function renderShopping() {
     const list = document.getElementById('shopping-list');
   
     if (!shoppingList.length) {
       list.innerHTML = '<div class="empty-state">No ingredients found.</div>';
       return;
     }
   
     const categories = {};
     shoppingList.forEach(item => {
       const cat = item.category || 'other';
       if (!categories[cat]) categories[cat] = [];
       categories[cat].push(item);
     });
   
     const order = ['meat', 'produce', 'dairy', 'pantry', 'other'];
     const sorted = Object.keys(categories).sort((a, b) => {
       const ai = order.indexOf(a), bi = order.indexOf(b);
       return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
     });
   
     list.innerHTML = sorted.map(cat => {
       const items = categories[cat].map(item => {
         const checked = checkedItems[item.name] ? 'checked' : '';
         return `
           <div class="shopping-item ${checked}" data-item="${item.name}">
             <div class="item-checkbox"></div>
             <div class="item-name">${item.display}</div>
           </div>
         `;
       }).join('');
   
       return `
         <div class="shopping-category">
           <div class="category-label">${cap(cat)}</div>
           ${items}
         </div>
       `;
     }).join('');
   
     list.querySelectorAll('.shopping-item').forEach(el => {
       el.addEventListener('click', () => {
         const name = el.dataset.item;
         checkedItems[name] = !checkedItems[name];
         saveState();
         el.classList.toggle('checked', checkedItems[name]);
       });
     });
   }
   
   /* ── Render: Cook View ── */
   
   function renderCookSelect() {
     const container = document.getElementById('cook-meal-select');
     const stepsContainer = document.getElementById('cook-steps');
   
     stepsContainer.classList.add('hidden');
     container.classList.remove('hidden');
   
     if (!mealData?.meals?.length) {
       container.innerHTML = '<div class="empty-state">No meals found.</div>';
       return;
     }
   
     const sorted = [...mealData.meals].sort((a, b) => new Date(a.date) - new Date(b.date));
   
     container.innerHTML = sorted.map(meal => `
       <button class="cook-meal-btn" data-meal="${meal.id}">
         <div class="cook-meal-btn-night">${meal.night} · ${formatDate(meal.date)}</div>
         <div class="cook-meal-btn-name">${meal.name}</div>
       </button>
     `).join('');
   
     container.querySelectorAll('.cook-meal-btn').forEach(btn => {
       btn.addEventListener('click', () => renderCookSteps(btn.dataset.meal));
     });
   }
   
   function renderCookSteps(mealId) {
     const meal = mealData.meals.find(m => m.id === mealId);
     if (!meal) return;
   
     const container = document.getElementById('cook-meal-select');
     const stepsContainer = document.getElementById('cook-steps');
   
     container.classList.add('hidden');
     stepsContainer.classList.remove('hidden');
   
     const ingredients = meal.ingredients || [];
     const steps = [...(meal.steps || [])].sort((a, b) => a.order - b.order);
   
     const ingredientRows = ingredients.map(ing => {
       const qty = formatUnit(ing.amount, ing.unit);
       const prep = ing.prep ? ` — ${ing.prep}` : '';
       return `<li class="cook-ingredient"><span class="ing-qty">${qty}</span> ${ing.name}${prep}</li>`;
     }).join('');
   
     const stepRows = steps.map(step => {
       const key = `${mealId}_${step.order}`;
       const done = doneSteps[key] ? 'done' : '';
       return `
         <div class="step ${done}" data-key="${key}">
           <div class="step-num">${step.order}</div>
           <div class="step-text">${step.instruction}</div>
         </div>
       `;
     }).join('');
   
     stepsContainer.innerHTML = `
       <button class="cook-back">← Back</button>
       <div class="cook-meal-title">${meal.name}</div>
       <div class="cook-section-label">Ingredients</div>
       <ul class="cook-ingredients">${ingredientRows}</ul>
       <div class="cook-section-label">Steps</div>
       ${stepRows}
     `;
   
     stepsContainer.querySelector('.cook-back').addEventListener('click', renderCookSelect);
   
     stepsContainer.querySelectorAll('.step').forEach(el => {
       el.addEventListener('click', () => {
         const key = el.dataset.key;
         doneSteps[key] = !doneSteps[key];
         saveState();
         el.classList.toggle('done', doneSteps[key]);
       });
     });
   }
   
   /* ── Render App ── */
   
   function renderApp() {
     renderMeals();
     renderShopping();
     renderCookSelect();
   }
   
   /* ── Helpers ── */
   
   function formatDate(dateStr) {
     const d = new Date(dateStr + 'T00:00:00');
     return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
   }
   
   function cap(str) {
     return str.charAt(0).toUpperCase() + str.slice(1);
   }
   
   /* ── Event Listeners ── */
   
   document.getElementById('btn-signin').addEventListener('click', signIn);
   document.getElementById('btn-retry').addEventListener('click', () => showScreen('auth'));
   document.getElementById('btn-refresh').addEventListener('click', () => {
     if (accessToken) loadMealsFromDrive();
     else showScreen('auth');
   });
   document.getElementById('btn-clear-checks').addEventListener('click', () => {
     checkedItems = {};
     saveState();
     renderShopping();
   });
   document.querySelectorAll('.nav-btn').forEach(btn => {
     btn.addEventListener('click', () => {
       showView(btn.dataset.view);
       if (btn.dataset.view === 'cook') renderCookSelect();
     });
   });
   
   /* ── Init ── */
   
   window.addEventListener('load', () => {
     const waitForGoogle = setInterval(() => {
       if (typeof google !== 'undefined' && google.accounts) {
         clearInterval(waitForGoogle);
         initGoogle();
       }
     }, 100);
   });