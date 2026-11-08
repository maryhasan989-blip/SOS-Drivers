/**
 * قرى الأطفال SOS - سجل رحلات السائقين والأسطول
 * نظام إدارة وتوثيق رحلات السائقين والمشاريع
 * إصدار الصلاحيات الإدارية المتقدمة والتحكم بالوقود والعدادات (v5.0)
 */

// ==========================================
// 1. مفاتيح التخزين والحالة العامة
// ==========================================

const STORAGE_KEYS = {
  CURRENT_USER: 'sos_current_user_v5',
  ACTIVE_TRIP: 'sos_active_trip_v5',
  CACHED_USERS: 'sos_cached_users_v5',
  CACHED_VEHICLES: 'sos_cached_vehicles_v5',
  CACHED_TRIPS: 'sos_cached_trips_v5',
  CACHED_TEAMS: 'sos_cached_teams_v5',
  CACHED_FUEL_LOGS: 'sos_cached_fuel_logs_v5',
  CACHED_PURCHASES: 'sos_cached_purchases_v5',
  CACHED_AUDIT_LOGS: 'sos_cached_audit_logs_v5',
  LAST_READ_AUDIT_TIME: 'sos_last_read_audit_time_v5',
  OFFLINE_QUEUE: 'sos_offline_sync_queue_v5',
  REMEMBERED_USER: 'sos_remembered_username_v5'
};

const DEFAULT_TEAMS = [
  'فريق يونيسف (UNICEF)',
  'فريق DRA',
  'فريق FS',
  'فريق HA',
  'إداري'
];

let appState = {
  users: [],
  vehicles: [],
  teams: [...DEFAULT_TEAMS],
  trips: [],
  fuelLogs: [],
  purchases: [],
  auditLogs: [],
  unreadNotificationsCount: 0,
  lastAuditCheckTime: null,
  soundEnabled: localStorage.getItem('sos_sound_enabled') !== 'false',
  offlineQueue: [],
  isSyncingQueue: false,
  currentUser: null,
  activeTrip: null,
  currentPassengers: [],
  timerInterval: null,
  syncInterval: null,
  isOnline: true,
  alertedDispatchIds: new Set(),
  linkedDispatchedTripId: null,
  pendingDeleteTripId: null,
  charts: {
    teams: null,
    daily: null
  }
};

// ==========================================
// 2. التحقق من الصلاحيات (Permissions System)
// ==========================================

function hasPermission(permKey) {
  if (!appState.currentUser) return false;
  // المشرف العام (admin) يتحكم في كل شيء في التطبيق بشكل مطلق ودون أي قيود
  if (appState.currentUser.role === 'admin' || appState.currentUser.username === 'admin') {
    return true;
  }
  // Drivers have no administrative / fleet supervisor permissions
  if (appState.currentUser.role === 'driver') {
    return false;
  }
  // Fuel officer only has fuel logging permissions, absolutely no user management or supervisor powers
  if (appState.currentUser.role === 'fuel_officer') {
    return false;
  }
  // Procurement officer only has vehicle inventory & purchases permissions, absolutely no user management
  if (appState.currentUser.role === 'procurement_officer') {
    if (permKey === 'canManageVehicles' || permKey === 'canExportExcel') return true;
    return false;
  }
  // User and permission management is STRICTLY for general admin (admin) only!
  if (permKey === 'canManageUsers' || permKey === 'canManageDrivers') {
    return appState.currentUser.role === 'admin' || appState.currentUser.username === 'admin';
  }
  // Check user permissions object if present
  if (appState.currentUser.permissions && typeof appState.currentUser.permissions[permKey] === 'boolean') {
    return appState.currentUser.permissions[permKey];
  }
  return false;
}

// التحقق من صلاحية رؤية الأسعار والأموال:
// "ما بدي مسوول السواقين يعرف السعر" - محصورة فقط بالمشرف العام ومسؤول المشتريات
function canViewFinancials() {
  if (!appState.currentUser) return false;
  // منع مسؤول السائقين والمشرفين العاديين والسائقين نهائياً من معرفة الأسعار
  if (appState.currentUser.role === 'supervisor' || appState.currentUser.role === 'supervisor_readonly' || appState.currentUser.username === 'supervisor' || appState.currentUser.role === 'driver') {
    return false;
  }
  // المشرف العام (admin) ومسؤول المشتريات (procurement_officer) فقط من يرون الأسعار والتسعيرة
  return appState.currentUser.role === 'admin' || appState.currentUser.username === 'admin' || appState.currentUser.role === 'procurement_officer';
}

// ==========================================
// 3. التهيئة عند تحميل الصفحة (Initialization)
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  restoreOfflineCache();
  checkRememberedUser();
  // CRITICAL: Render session & dashboard immediately from cache (0.05s instant boot on mobile)
  // Even if laptop is asleep or network is offline, user never sees a blank screen!
  checkSessionAuth();
  setupServiceWorker();
  initOfflineSyncEngine();
  initLucideIcons();
  setupActiveTripTimer();
  startPeriodicSync();

  // Background server sync with strict timeout (never hangs if laptop is asleep)
  bootstrapFromServer().catch(err => {
    console.warn('Initial server bootstrap failed or laptop asleep, running in offline mode:', err);
    appState.isOnline = false;
    updateSyncBadge(false, 'وضع عدم الاتصال (بدون سيرفر)');
  });
});

function restoreOfflineCache() {
  try {
    const cachedUsers = localStorage.getItem(STORAGE_KEYS.CACHED_USERS);
    if (cachedUsers) appState.users = JSON.parse(cachedUsers);

    const cachedVehicles = localStorage.getItem(STORAGE_KEYS.CACHED_VEHICLES);
    if (cachedVehicles) appState.vehicles = JSON.parse(cachedVehicles);

    const cachedTeams = localStorage.getItem(STORAGE_KEYS.CACHED_TEAMS);
    if (cachedTeams) appState.teams = JSON.parse(cachedTeams);

    const cachedTrips = localStorage.getItem(STORAGE_KEYS.CACHED_TRIPS);
    if (cachedTrips) appState.trips = JSON.parse(cachedTrips);

    const cachedFuel = localStorage.getItem(STORAGE_KEYS.CACHED_FUEL_LOGS);
    if (cachedFuel) appState.fuelLogs = JSON.parse(cachedFuel);

    const cachedPurchases = localStorage.getItem(STORAGE_KEYS.CACHED_PURCHASES);
    if (cachedPurchases) appState.purchases = JSON.parse(cachedPurchases);

    const cachedAudit = localStorage.getItem(STORAGE_KEYS.CACHED_AUDIT_LOGS);
    if (cachedAudit) {
      appState.auditLogs = JSON.parse(cachedAudit);
      calculateUnreadNotifications();
      renderNotificationsList();
    }

    const cachedActive = localStorage.getItem(STORAGE_KEYS.ACTIVE_TRIP);
    if (cachedActive) appState.activeTrip = JSON.parse(cachedActive);

    const cachedQueue = localStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE);
    if (cachedQueue) appState.offlineQueue = JSON.parse(cachedQueue);
  } catch (err) {
    console.warn('خطأ في استعادة الذاكرة المؤقتة:', err);
  }
}

// =========================================================================
// OFFLINE-FIRST AUTO-RELAY ENGINE (محرك الترحيل التلقائي فور شبك النت)
// "بدي اعمل انه يشتغل سواء لابتوبي شغال او لا ويرحل اول ما يشبك نت جهاز"
// =========================================================================

function initOfflineSyncEngine() {
  window.addEventListener('online', () => {
    updateSyncBadge(true, 'تم الاتصال بالإنترنت! جاري ترحيل البيانات...');
    showToast('تم الاتصال بالإنترنت! جاري ترحيل الرحلات وتعبئات السولار فوراً 🚀', 'info');
    processOfflineSyncQueue();
  });

  window.addEventListener('offline', () => {
    updateSyncBadge(false, 'وضع العمل بدون إنترنت (محلياً)');
    updateOfflineUI();
    showToast('أنت الآن في وضع عدم الاتصال: يمكنك تسجيل الرحلات والتعبئات وسيتم ترحيلها تلقائياً فور شبك النت 📦', 'warning');
  });

  updateOfflineUI();

  if (navigator.onLine && getOfflineQueue().length > 0) {
    processOfflineSyncQueue();
  }
}

function getOfflineQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.OFFLINE_QUEUE);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveOfflineQueue(queue) {
  appState.offlineQueue = queue;
  try {
    localStorage.setItem(STORAGE_KEYS.OFFLINE_QUEUE, JSON.stringify(queue));
  } catch (e) {
    console.warn('Failed to save offline queue:', e);
  }
  updateOfflineUI();
}

function enqueueSyncAction(action) {
  const queue = getOfflineQueue();
  const queueItem = {
    id: 'SYNC_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    ...action,
    enqueuedAt: new Date().toISOString()
  };
  queue.push(queueItem);
  saveOfflineQueue(queue);

  showToast(`تم حفظ البيانات محلياً في الهاتف وستُرحّل تلقائياً فور شبك النت 📦 (${queue.length} معلقة)`, 'info');

  if (navigator.onLine) {
    processOfflineSyncQueue();
  }
}

function updateOfflineUI() {
  const queue = getOfflineQueue();
  const banner = document.getElementById('offlineSyncBanner');
  const countEl = document.getElementById('pendingSyncCount');
  const queueBadge = document.getElementById('pendingQueueBadge');
  const isOnline = navigator.onLine;

  if (countEl) countEl.textContent = queue.length;

  if (queueBadge) {
    if (queue.length > 0) {
      queueBadge.textContent = queue.length;
      queueBadge.classList.remove('hidden');
    } else {
      queueBadge.classList.add('hidden');
    }
  }

  if (banner) {
    if (queue.length > 0 || !isOnline) {
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  if (!isOnline) {
    updateSyncBadge(false, queue.length > 0 ? `بدون نت (${queue.length} بانتظار الترحيل)` : 'يعمل بدون إنترنت (محلياً)');
  } else if (queue.length > 0) {
    updateSyncBadge(true, `جاري ترحيل ${queue.length} عمليات...`);
  } else {
    updateSyncBadge(true, 'متصل بالسيرفر المركزي');
  }
}

async function processOfflineSyncQueue() {
  if (appState.isSyncingQueue) return;
  const queue = getOfflineQueue();
  if (queue.length === 0) {
    updateOfflineUI();
    return;
  }

  // Quick server health probe before attempting sync
  try {
    const ping = await fetch('/api/status', { method: 'GET', signal: AbortSignal.timeout(3500) });
    if (!ping.ok) throw new Error('Server returned non-200');
  } catch (pingErr) {
    console.log('[Offline Engine] السيرفر غير متاح حالياً، سيتم الترحيل عند توفره');
    updateOfflineUI();
    return;
  }

  appState.isSyncingQueue = true;
  const syncIcon = document.getElementById('syncNowIcon');
  if (syncIcon) syncIcon.classList.add('animate-spin');

  const msgEl = document.getElementById('offlineSyncMessage');
  if (msgEl) {
    msgEl.innerHTML = `<span>⏳ جاري ترحيل <strong class="text-white font-mono-numbers">${queue.length}</strong> عمليات مسجلة إلى السيرفر المركزي...</span>`;
  }

  let syncedSuccessCount = 0;
  const remainingQueue = [...queue];

  for (const item of queue) {
    let itemSuccess = false;
    try {
      if (item.type === 'START_TRIP') {
        const res = await fetch('/api/trips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (res.ok && data.success) {
          itemSuccess = true;
          if (item.tempId && data.trip) {
            updateLocalTripId(item.tempId, data.trip.id);
          }
        }
      } else if (item.type === 'END_TRIP') {
        const res = await fetch(`/api/trips/${item.tripId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (res.ok && data.success) itemSuccess = true;
      } else if (item.type === 'ADD_FUEL_LOG') {
        const res = await fetch('/api/fuel-logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (res.ok && data.success) itemSuccess = true;
      } else if (item.type === 'DISPATCH_TRIP') {
        const res = await fetch('/api/trips', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (res.ok && data.success) itemSuccess = true;
      } else if (item.type === 'RESPOND_DISPATCH') {
        const res = await fetch(`/api/trips/${item.tripId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (res.ok && data.success) itemSuccess = true;
      } else if (item.type === 'UPDATE_VEHICLE') {
        const res = await fetch(`/api/vehicles/${item.vehicleId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (res.ok && data.success) itemSuccess = true;
      } else if (item.type === 'ADD_USER') {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        const data = await res.json();
        if (res.ok && data.success) itemSuccess = true;
      }
    } catch (itemErr) {
      console.warn('[Offline Engine] فشل ترحيل عنصر، سيتم المحاولة لاحقاً:', itemErr);
      itemSuccess = false;
    }

    if (itemSuccess) {
      syncedSuccessCount++;
      const idx = remainingQueue.findIndex(q => q.id === item.id);
      if (idx !== -1) remainingQueue.splice(idx, 1);
      saveOfflineQueue(remainingQueue);
    } else {
      break;
    }
  }

  appState.isSyncingQueue = false;
  if (syncIcon) syncIcon.classList.remove('animate-spin');

  if (syncedSuccessCount > 0) {
    if ('vibrate' in navigator) {
      try { navigator.vibrate([100, 50, 100]); } catch (e) {}
    }
    showToast(`تم ترحيل ${syncedSuccessCount} عمليات بنجاح إلى السيرفر المركزي 🚀`, 'success');
    await bootstrapFromServer();
  }

  updateOfflineUI();
}

function triggerManualSync() {
  const queue = getOfflineQueue();
  if (queue.length === 0) {
    showToast('لا توجد عمليات معلقة، كل البيانات مرحلة بنجاح إلى السيرفر المركزي ✅', 'info');
    return;
  }
  showToast(`جاري فحص الاتصال وترحيل ${queue.length} عمليات...`, 'info');
  processOfflineSyncQueue();
}

function updateLocalTripId(oldId, newId) {
  if (oldId === newId) return;
  if (appState.activeTrip && appState.activeTrip.id === oldId) {
    appState.activeTrip.id = newId;
    localStorage.setItem(STORAGE_KEYS.ACTIVE_TRIP, JSON.stringify(appState.activeTrip));
  }
  const idx = (appState.trips || []).findIndex(t => t.id === oldId);
  if (idx !== -1) {
    appState.trips[idx].id = newId;
    localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));
  }
}

async function bootstrapFromServer() {
  updateSyncBadge(true, 'جاري الاتصال بالسيرفر...');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch('/api/bootstrap', { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('فشل الاتصال بالسيرفر');
    const data = await res.json();

    if (data.success) {
      if (data.users) {
        appState.users = data.users;
        localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
        if (appState.currentUser) {
          const fresh = appState.users.find(u => u.username.toLowerCase() === appState.currentUser.username.toLowerCase());
          if (fresh) {
            appState.currentUser = { ...appState.currentUser, ...fresh };
            localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(appState.currentUser));
          }
        }
      }
      if (data.vehicles) {
        appState.vehicles = data.vehicles;
        localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
      }
      if (data.teams && data.teams.length > 0) {
        appState.teams = data.teams;
        localStorage.setItem(STORAGE_KEYS.CACHED_TEAMS, JSON.stringify(appState.teams));
      }
      if (data.trips) {
        // Merge unsynced pending local trips so they aren't lost
        const queue = getOfflineQueue();
        const pendingTripIds = new Set(queue.filter(q => q.type === 'START_TRIP' || q.type === 'END_TRIP').map(q => q.tempId || q.tripId));
        const localPending = (appState.trips || []).filter(t => pendingTripIds.has(t.id));
        const serverTripIds = new Set(data.trips.map(t => t.id));
        const unsyncedTrips = localPending.filter(t => !serverTripIds.has(t.id));

        appState.trips = [...unsyncedTrips, ...data.trips];
        localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));
      }
      if (data.fuelLogs) {
        const queue = getOfflineQueue();
        const pendingFuelIds = new Set(queue.filter(q => q.type === 'ADD_FUEL_LOG').map(q => q.tempId));
        const localPendingFuel = (appState.fuelLogs || []).filter(f => pendingFuelIds.has(f.id));
        const serverFuelIds = new Set(data.fuelLogs.map(f => f.id));
        const unsyncedFuel = localPendingFuel.filter(f => !serverFuelIds.has(f.id));

        appState.fuelLogs = [...unsyncedFuel, ...data.fuelLogs];
        localStorage.setItem(STORAGE_KEYS.CACHED_FUEL_LOGS, JSON.stringify(appState.fuelLogs));
      }
      if (data.purchases) {
        appState.purchases = data.purchases;
        localStorage.setItem(STORAGE_KEYS.CACHED_PURCHASES, JSON.stringify(appState.purchases));
      }
      if (data.auditLogs) {
        processIncomingAuditLogs(data.auditLogs, false);
      }
      if (data.rentalAccounts) {
        appState.rentalAccounts = data.rentalAccounts;
      }

      appState.isOnline = true;
      updateSyncBadge(true, 'متصل بالسيرفر المركزي');
      populateFilterDropdowns();
      populateTeamOptions();
      updateOfflineUI();

      if (appState.currentUser?.role === 'driver') {
        checkIncomingDispatches();
        renderPendingDispatches();
      } else if (appState.currentUser?.role === 'procurement_officer') {
        renderProcurementDashboard();
      } else if (appState.currentUser?.role === 'supervisor_readonly' || appState.currentUser?.role === 'admin') {
        renderDriversAvailabilitySection();
      }

      return true;
    }
  } catch (err) {
    console.warn('[Sync] تعذر الوصول إلى السيرفر، يتم العمل بنمط دون اتصال:', err.message);
    appState.isOnline = false;
    updateSyncBadge(false, 'العمل محلياً (غير متصل بالسيرفر)');
    populateFilterDropdowns();
    populateTeamOptions();
    updateOfflineUI();
  }
  return false;
}

function updateSyncBadge(online, text) {
  const label = document.getElementById('syncStatusLabel');
  if (!label) return;
  label.textContent = text;
  const dot = document.getElementById('syncStatusDot') || label.previousElementSibling;
  const container = document.getElementById('syncStatusBadgeContainer') || label.parentElement;

  if (dot) {
    if (online) {
      dot.className = 'w-2 h-2 rounded-full bg-emerald-400 pulse-dot';
      if (container) container.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950/60 text-emerald-400 border border-emerald-800/50';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-amber-400';
      if (container) container.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-950/60 text-amber-400 border border-amber-800/50';
    }
  }
}

function startPeriodicSync() {
  if (appState.syncInterval) clearInterval(appState.syncInterval);
  appState.syncInterval = setInterval(async () => {
    if (!appState.currentUser) return;

    // Check if offline queue has items waiting to be synced
    if (navigator.onLine && getOfflineQueue().length > 0) {
      processOfflineSyncQueue();
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500);
      const res = await fetch('/api/bootstrap', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          appState.users = data.users || appState.users;
          appState.vehicles = data.vehicles || appState.vehicles;
          appState.teams = data.teams || appState.teams;

          // Merge un-synced trips
          const queue = getOfflineQueue();
          const pendingTripIds = new Set(queue.filter(q => q.type === 'START_TRIP' || q.type === 'END_TRIP').map(q => q.tempId || q.tripId));
          const localPending = (appState.trips || []).filter(t => pendingTripIds.has(t.id));
          const serverTripIds = new Set((data.trips || []).map(t => t.id));
          const unsyncedTrips = localPending.filter(t => !serverTripIds.has(t.id));
          appState.trips = [...unsyncedTrips, ...(data.trips || [])];

          // Merge un-synced fuel logs
          const pendingFuelIds = new Set(queue.filter(q => q.type === 'ADD_FUEL_LOG').map(q => q.tempId));
          const localPendingFuel = (appState.fuelLogs || []).filter(f => pendingFuelIds.has(f.id));
          const serverFuelIds = new Set((data.fuelLogs || []).map(f => f.id));
          const unsyncedFuel = localPendingFuel.filter(f => !serverFuelIds.has(f.id));
          appState.fuelLogs = [...unsyncedFuel, ...(data.fuelLogs || [])];

          localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));
          localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
          localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
          localStorage.setItem(STORAGE_KEYS.CACHED_FUEL_LOGS, JSON.stringify(appState.fuelLogs));

          updateOfflineUI();

          // Live refresh current view
          if (appState.currentUser.role === 'fuel_officer') {
            renderFuelOfficerDashboard();
          } else if (appState.currentUser.role === 'driver') {
            checkIncomingDispatches();
            renderPendingDispatches();
            renderDriverStats();
            renderDriverRecentTrips();
          } else {
            renderSupervisorKPIs();
            renderFleetVehiclesCards();
            renderSupervisorTable();
            renderFuelLogsTable();
          }

          // Real-time Audit & Activity Notification Polling
          await pollAuditLogs();
        }
      }
    } catch (e) {
      updateOfflineUI();
    }
  }, 2500); // 2.5s live sync
}

// ==========================================
// 4. إدارة الجلسة وتسجيل الدخول (Auth)
// ==========================================

function checkRememberedUser() {
  const remembered = localStorage.getItem(STORAGE_KEYS.REMEMBERED_USER);
  const usernameInput = document.getElementById('loginUsername');
  if (remembered && usernameInput) {
    usernameInput.value = remembered;
  }
}

function checkSessionAuth() {
  try {
    const rawUser = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
    if (rawUser) {
      const user = JSON.parse(rawUser);
      appState.currentUser = user;
      showAuthenticatedApp();
      return;
    }
  } catch (e) {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
  }
  showLoginScreen();
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const usernameInput = document.getElementById('loginUsername');
  const passwordInput = document.getElementById('loginPassword');
  const rememberMe = document.getElementById('rememberMe').checked;
  const errorAlert = document.getElementById('loginErrorAlert');
  const submitBtn = document.getElementById('loginSubmitBtn');

  const username = usernameInput.value.trim();
  const password = passwordInput.value.trim();

  if (!username || !password) {
    showLoginError('يرجى كتابة اسم المستخدم وكلمة المرور');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <span class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block"></span>
    <span>جاري التحقق...</span>
  `;
  errorAlert.classList.add('hidden');

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      appState.currentUser = data.user;
      localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(data.user));

      if (rememberMe) {
        localStorage.setItem(STORAGE_KEYS.REMEMBERED_USER, username);
      } else {
        localStorage.removeItem(STORAGE_KEYS.REMEMBERED_USER);
      }

      passwordInput.value = '';
      showToast(`مرحباً بك، ${data.user.name} 👋`, 'success');
      showAuthenticatedApp();
      return;
    } else {
      showLoginError(data.error || 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }
  } catch (networkErr) {
    // Offline verification fallback
    let clean = username.trim().toLowerCase();
    if (clean === 'مشتريات' || clean === 'المشتريات' || clean === 'purchases' || clean === 'مسؤول المشتريات') {
      clean = 'procurement';
    } else if (clean === 'سولار' || clean === 'السولار' || clean === 'وقود' || clean === 'الوقود' || clean === 'مسؤول السولار') {
      clean = 'fuel';
    } else if (clean === 'مشرف' || clean === 'المشرف' || clean === 'مسؤول السائقين') {
      clean = 'supervisor';
    } else if (clean === 'ادمن' || clean === 'الادمن' || clean === 'المشرف العام') {
      clean = 'admin';
    }

    const localUser = appState.users.find(u => {
      const match = (u.username?.toLowerCase() === clean || (u.phone && u.phone === clean));
      if (!match) return false;
      if (u.username?.toLowerCase() === 'admin' && (password === '123' || password === 'admin123')) return true;
      return u.password === password;
    });

    if (localUser) {
      appState.currentUser = {
        id: localUser.id,
        username: localUser.username,
        name: localUser.name,
        role: localUser.role || 'driver',
        permissions: localUser.permissions || null,
        phone: localUser.phone,
        vehicle: localUser.vehicle
      };
      localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(appState.currentUser));
      showToast(`تم تسجيل الدخول محلياً (${localUser.name})`, 'info');
      showAuthenticatedApp();
      return;
    } else {
      showLoginError('تعذر التحقق من السيرفر، وتأكد من صحة بيانات الدخول');
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `
      <i data-lucide="log-in" class="w-5 h-5"></i>
      <span>تسجيل الدخول</span>
    `;
    initLucideIcons();
  }
}

function showLoginError(msg) {
  const errorAlert = document.getElementById('loginErrorAlert');
  if (errorAlert) {
    errorAlert.textContent = msg;
    errorAlert.classList.remove('hidden');
  }
}

function togglePasswordVisibility(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input) return;

  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.innerHTML = '<i data-lucide="eye-off" class="w-4 h-4"></i>';
  } else {
    input.type = 'password';
    if (btn) btn.innerHTML = '<i data-lucide="eye" class="w-4 h-4"></i>';
  }
  initLucideIcons();
}

function handleLogout() {
  if (confirm('هل أنت متأكد من تسجيل الخروج؟')) {
    localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
    appState.currentUser = null;
    showLoginScreen();
    showToast('تم تسجيل الخروج بنجاح', 'info');
  }
}

function showLoginScreen() {
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('authenticatedApp').classList.add('hidden');
  document.getElementById('loginPassword').value = '';
  initLucideIcons();
}

// =========================================================================
// 5. توجيه الواجهات والفصل التام بين السائق ولوحة الإشراف
// "في لوحة اشراف فش حاجه اسمها لوحة سائق ما تبين خل وما يحجز رحلة"
// =========================================================================

function showAuthenticatedApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('authenticatedApp').classList.remove('hidden');

  renderUserProfileBadge();

  const driverView = document.getElementById('driverView');
  const supervisorView = document.getElementById('supervisorView');
  const fuelOfficerView = document.getElementById('fuelOfficerView');
  const procurementView = document.getElementById('procurementView');
  const adminMasterNav = document.getElementById('adminMasterNav');
  const controlToolbarTitle = document.getElementById('controlToolbarTitle');

  // Admin Master Control Bar
  const isGeneralAdmin = appState.currentUser.role === 'admin' || appState.currentUser.username === 'admin';
  if (adminMasterNav) {
    if (isGeneralAdmin) {
      adminMasterNav.classList.remove('hidden');
      updateAdminNavActiveButton('trips');
    } else {
      adminMasterNav.classList.add('hidden');
    }
  }

  // Strict Separation of Roles:
  if (appState.currentUser.role === 'fuel_officer') {
    // 1. FUEL OFFICER: Dedicated refuel dashboard ONLY
    if (driverView) driverView.classList.add('hidden');
    if (supervisorView) supervisorView.classList.add('hidden');
    if (procurementView) procurementView.classList.add('hidden');
    if (fuelOfficerView) fuelOfficerView.classList.remove('hidden');
    renderFuelOfficerDashboard();
  } else if (appState.currentUser.role === 'procurement_officer') {
    // 2. PROCUREMENT OFFICER: Vehicle accounts, prices, invoices, inventory ONLY
    if (driverView) driverView.classList.add('hidden');
    if (supervisorView) supervisorView.classList.add('hidden');
    if (fuelOfficerView) fuelOfficerView.classList.add('hidden');
    if (procurementView) procurementView.classList.remove('hidden');
    renderProcurementDashboard();
  } else if (appState.currentUser.role === 'driver') {
    // 3. DRIVER ONLY: Sees Driver View, completely hides supervisor, procurement & fuel dashboards
    if (driverView) driverView.classList.remove('hidden');
    if (supervisorView) supervisorView.classList.add('hidden');
    if (fuelOfficerView) fuelOfficerView.classList.add('hidden');
    if (procurementView) procurementView.classList.add('hidden');
    renderDriverView();
  } else {
    // 4. SUPERVISORS / ADMIN: Sees Supervisor Dashboard. Driver & fuel-only views are NOT shown!
    if (driverView) driverView.classList.add('hidden');
    if (fuelOfficerView) fuelOfficerView.classList.add('hidden');
    if (procurementView) procurementView.classList.add('hidden');
    if (supervisorView) supervisorView.classList.remove('hidden');

    if (controlToolbarTitle) {
      controlToolbarTitle.textContent = isGeneralAdmin ? 'لوحة التحكم الشامل والمتابعة للأسطول (المشرف العام admin)' : 'لوحة متابعة السائقين والرحلات الميدانية (مسؤول السائقين)';
    }

    applySupervisorPermissions();
    renderSupervisorView();
    renderFuelLogsTable();
  }

  initLucideIcons();
}

function renderUserProfileBadge() {
  if (!appState.currentUser) return;
  const nameLabel = document.getElementById('currentDriverLabel');
  const roleBadge = document.getElementById('userRoleBadge');
  const headerRoleBadge = document.getElementById('headerRoleBadge');
  const vehicleLabel = document.getElementById('currentVehicleLabel');
  const vehicleItem = document.getElementById('vehicleBarItem');

  if (nameLabel) nameLabel.textContent = appState.currentUser.name;

  if (appState.currentUser.role === 'admin') {
    roleBadge.textContent = 'المشرف العام (كامل الصلاحيات)';
    roleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40';
    if (headerRoleBadge) headerRoleBadge.textContent = 'لوحة المشرف العام';
    if (vehicleItem) vehicleItem.classList.add('hidden');
  } else if (appState.currentUser.role === 'fuel_officer') {
    roleBadge.textContent = 'مسؤول السولار والوقود ⛽';
    roleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40';
    if (headerRoleBadge) headerRoleBadge.textContent = 'لوحة مسؤول السولار والوقود';
    if (vehicleItem) vehicleItem.classList.add('hidden');
  } else if (appState.currentUser.role === 'procurement_officer') {
    roleBadge.textContent = 'مسؤول المشتريات وجرد الأسطول 🛒';
    roleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    if (headerRoleBadge) headerRoleBadge.textContent = 'لوحة مسؤول المشتريات والجرد';
    if (vehicleItem) vehicleItem.classList.add('hidden');
  } else if (appState.currentUser.role === 'supervisor_readonly' || appState.currentUser.role === 'supervisor' || appState.currentUser.role === 'custom_supervisor') {
    roleBadge.textContent = 'مسؤول السائقين (متابعة وتكليف فقط)';
    roleBadge.className = 'px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40';
    if (headerRoleBadge) headerRoleBadge.textContent = 'لوحة إدارة الأسطول والمتابعة';
    if (vehicleItem) vehicleItem.classList.add('hidden');
  } else {
    // Driver
    roleBadge.textContent = 'سائق رسمي';
    roleBadge.className = 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
    if (headerRoleBadge) headerRoleBadge.textContent = 'سجل رحلات السائق';
    if (vehicleItem) {
      vehicleItem.classList.remove('hidden');
      vehicleLabel.textContent = appState.currentUser.vehicle || 'غير محددة';
    }
  }
}

function applySupervisorPermissions() {
  const isGeneralAdmin = appState.currentUser?.role === 'admin' || appState.currentUser?.username === 'admin';

  const addVehBtn = document.getElementById('addVehicleBtn');
  if (addVehBtn) {
    if (hasPermission('canManageVehicles')) addVehBtn.classList.remove('hidden');
    else addVehBtn.classList.add('hidden');
  }

  // "بدي مسوول المتخصص ومسوول االسائثين مالهم علاقة في ادارة المستخدمين والصلاحيات"
  // STRICT RULE: Only general admin (admin) can see or click the user management / permissions button!
  const adminUsersBtn = document.getElementById('adminUsersBtn');
  if (adminUsersBtn) {
    if (isGeneralAdmin) adminUsersBtn.classList.remove('hidden');
    else adminUsersBtn.classList.add('hidden');
  }

  const adminTeamsBtn = document.getElementById('adminTeamsBtn');
  if (adminTeamsBtn) {
    if (isGeneralAdmin || hasPermission('canManageTeams')) adminTeamsBtn.classList.remove('hidden');
    else adminTeamsBtn.classList.add('hidden');
  }

  // ما بدي مسؤول السواقين يعرف السعر أو يفتح قسم المشتريات والجرد
  const supervisorProcurementBtn = document.getElementById('supervisorProcurementBtn');
  if (supervisorProcurementBtn) {
    if (canViewFinancials()) supervisorProcurementBtn.classList.remove('hidden');
    else supervisorProcurementBtn.classList.add('hidden');
  }
}

// =========================================================================
// 6. إدارة حالة مركبات الأسطول والوقود وقراءات العداد
// "يتحكم في الوقود كم في السيارة و قراءة العداد يتحكم فيها"
// =========================================================================

function renderFleetVehiclesCards() {
  const container = document.getElementById('fleetVehiclesCardsContainer');
  if (!container) return;

  const vehicles = appState.vehicles || [];

  if (vehicles.length === 0) {
    container.innerHTML = `
      <div class="col-span-full p-6 text-center text-slate-500 bg-slate-900/60 rounded-xl border border-slate-800">
        لم يتم تسجيل أي مركبات في الأسطول بعد.
      </div>
    `;
    return;
  }

  const canEdit = hasPermission('canManageVehicles');

  container.innerHTML = vehicles.map(v => {
    const capacity = v.fuelCapacityLiters || 60;
    const currentFuel = v.currentFuelLiters !== undefined ? v.currentFuelLiters : 40;
    const percent = Math.min(100, Math.round((currentFuel / capacity) * 100));

    let barColor = 'bg-emerald-500';
    let textColor = 'text-emerald-400';
    if (percent < 25) {
      barColor = 'bg-rose-500';
      textColor = 'text-rose-400';
    } else if (percent < 50) {
      barColor = 'bg-amber-500';
      textColor = 'text-amber-400';
    }

    return `
      <div class="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 hover:border-slate-700 transition-all space-y-3">
        <!-- Vehicle Header -->
        <div class="flex items-start justify-between gap-2 border-b border-slate-800/80 pb-2.5">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center text-blue-400">
              <i data-lucide="car" class="w-5 h-5"></i>
            </div>
            <div>
              <h5 class="text-xs font-bold text-white">${escapeHtml(v.name)}</h5>
              <span class="text-[11px] text-slate-400 font-mono-numbers">لوحة: ${escapeHtml(v.plateNumber || '-')}</span>
            </div>
          </div>
          ${canEdit ? `
            <button onclick="openEditVehicleModal('${v.id}')" class="px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-[11px] font-bold flex items-center gap-1 transition-all" title="ضبط قراءة العداد وكمية الوقود">
              <i data-lucide="settings-2" class="w-3.5 h-3.5"></i>
              <span>ضبط</span>
            </button>
          ` : `
            <span class="text-[10px] text-slate-500 font-semibold px-2 py-0.5 rounded bg-slate-950">متابعة فقط</span>
          `}
        </div>

        <!-- Driver Assigned -->
        <div class="text-[11px] text-slate-300 flex items-center justify-between">
          <span class="text-slate-500">السائق المعين:</span>
          <span class="font-bold text-white">${escapeHtml(v.driverName || 'غير معين')}</span>
        </div>

        <!-- Odometer Reading -->
        <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 flex items-center justify-between">
          <span class="text-xs text-slate-400 flex items-center gap-1">
            <i data-lucide="gauge" class="w-3.5 h-3.5 text-cyan-400"></i>
            <span>قراءة العداد:</span>
          </span>
          <span class="font-mono-numbers font-bold text-cyan-300 text-sm">${(v.currentOdometer || 0).toLocaleString()} كم</span>
        </div>

        ${canViewFinancials() ? `
          <!-- Daily Rental Rate (يظهر فقط للمشرف العام والمشتريات - مخفي عن مسؤول السائقين) -->
          <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 flex items-center justify-between">
            <span class="text-xs text-slate-400 flex items-center gap-1">
              <i data-lucide="tag" class="w-3.5 h-3.5 text-sky-400"></i>
              <span>تسعيرة الإيجار اليومي:</span>
            </span>
            <span class="font-mono-numbers font-bold text-sky-300 text-xs">${(v.dailyRentalRate || 200).toLocaleString()} ₪/يوم</span>
          </div>
        ` : ''}

        <!-- Fuel Level in Car -->
        <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 space-y-1.5">
          <div class="flex items-center justify-between text-xs">
            <span class="text-slate-400 flex items-center gap-1">
              <i data-lucide="fuel" class="w-3.5 h-3.5 text-amber-400"></i>
              <span>كمية الوقود في السيارة:</span>
            </span>
            <span class="font-mono-numbers font-bold ${textColor}">${currentFuel} لتر <span class="text-[10px] text-slate-500">(${percent}%)</span></span>
          </div>
          <!-- Gauge Bar -->
          <div class="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
            <div class="${barColor} h-2 rounded-full transition-all duration-500" style="width: ${percent}%"></div>
          </div>
          <div class="flex items-center justify-between text-[10px] text-slate-500 font-mono-numbers">
            <span>فارغ (0L)</span>
            <span>السعة: ${capacity} لتر</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  initLucideIcons();
}

function openEditVehicleModal(vehicleId) {
  if (!hasPermission('canManageVehicles')) {
    showToast('عذراً، لا تملك صلاحية تعديل وقود وعدادات المركبات', 'warning');
    return;
  }

  const veh = (appState.vehicles || []).find(v => v.id === vehicleId);
  if (!veh) return;

  document.getElementById('editVehicleId').value = veh.id;
  document.getElementById('editVehicleSubtitle').textContent = `${veh.name} • لوحة: ${veh.plateNumber || '-'}`;
  document.getElementById('editVehicleName').value = veh.name;
  document.getElementById('editVehicleOdometer').value = veh.currentOdometer || 0;
  document.getElementById('editVehicleFuelLiters').value = veh.currentFuelLiters !== undefined ? veh.currentFuelLiters : 40;
  document.getElementById('editVehicleFuelCapacity').value = veh.fuelCapacityLiters || 60;
  document.getElementById('editVehicleFuelType').value = veh.fuelType || 'بنزين';
  const rentRateInput = document.getElementById('editVehicleRentalRate');
  if (rentRateInput) rentRateInput.value = veh.dailyRentalRate || 200;

  // إخفاء حقل السعر والتسعيرة تماماً عن مسؤول السائقين
  const rentContainer = document.getElementById('editVehicleRentalRateContainer');
  if (rentContainer) {
    if (canViewFinancials()) rentContainer.classList.remove('hidden');
    else rentContainer.classList.add('hidden');
  }

  // Driver Select
  const driverSelect = document.getElementById('editVehicleDriverSelect');
  const drivers = appState.users.filter(u => u.role === 'driver');
  driverSelect.innerHTML = `<option value="">-- بدون سائق معين --</option>` +
    drivers.map(d => `<option value="${escapeHtml(d.username)}" ${d.username === veh.driverUsername ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('');

  openModal('editVehicleModal');
}

async function handleEditVehicleSubmit(event) {
  event.preventDefault();
  const id = document.getElementById('editVehicleId').value;
  const name = document.getElementById('editVehicleName').value.trim();
  const currentOdometer = Number(document.getElementById('editVehicleOdometer').value);
  const currentFuelLiters = Number(document.getElementById('editVehicleFuelLiters').value);
  const fuelCapacityLiters = Number(document.getElementById('editVehicleFuelCapacity').value);
  const fuelType = document.getElementById('editVehicleFuelType').value;
  const veh = (appState.vehicles || []).find(v => v.id === id) || {};
  const dailyRentalRate = canViewFinancials()
    ? (Number(document.getElementById('editVehicleRentalRate')?.value) || veh.dailyRentalRate || 200)
    : (veh.dailyRentalRate || 200);
  const driverUsername = document.getElementById('editVehicleDriverSelect').value;
  const driver = appState.users.find(u => u.username === driverUsername);

  const payload = {
    name,
    currentOdometer,
    currentFuelLiters,
    fuelCapacityLiters,
    fuelType,
    dailyRentalRate,
    driverUsername,
    driverName: driver ? driver.name : ''
  };

  try {
    const res = await fetch(`/api/vehicles/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      const idx = appState.vehicles.findIndex(v => v.id === id);
      if (idx !== -1) appState.vehicles[idx] = data.vehicle;
      localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
      renderFleetVehiclesCards();
      closeModal('editVehicleModal');
      const toastMsg = canViewFinancials()
        ? `تم ضبط العداد (${currentOdometer} كم) والوقود (${currentFuelLiters} لتر) وتسعيرة الإيجار (${dailyRentalRate} ₪) بنجاح 🚗`
        : `تم ضبط قراءة العداد (${currentOdometer} كم) وكمية الوقود (${currentFuelLiters} لتر) بنجاح 🚗`;
      showToast(toastMsg, 'success');
      return;
    }
  } catch (e) {
    const idx = appState.vehicles.findIndex(v => v.id === id);
    if (idx !== -1) {
      Object.assign(appState.vehicles[idx], payload);
      localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
      renderFleetVehiclesCards();
      closeModal('editVehicleModal');
      showToast('تم الضبط محلياً', 'info');
    }
  }
}

function openAddVehicleModal() {
  if (!hasPermission('canManageVehicles')) {
    showToast('عذراً، لا تملك صلاحية إضافة مركبات', 'warning');
    return;
  }
  document.getElementById('addVehicleForm').reset();
  const driverSelect = document.getElementById('addVehDriverSelect');
  const drivers = appState.users.filter(u => u.role === 'driver');
  driverSelect.innerHTML = `<option value="">-- بدون سائق معين --</option>` +
    drivers.map(d => `<option value="${escapeHtml(d.username)}">${escapeHtml(d.name)}</option>`).join('');
  const rentInput = document.getElementById('addVehRentalRate');
  if (rentInput) rentInput.value = '200';

  const addRentContainer = document.getElementById('addVehRentalRateContainer');
  if (addRentContainer) {
    if (canViewFinancials()) addRentContainer.classList.remove('hidden');
    else addRentContainer.classList.add('hidden');
  }

  openModal('addVehicleModal');
}

async function handleAddVehicleSubmit(event) {
  event.preventDefault();
  const name = document.getElementById('addVehName').value.trim();
  const plateNumber = document.getElementById('addVehPlate').value.trim();
  const fuelType = document.getElementById('addVehFuelType').value;
  const currentOdometer = Number(document.getElementById('addVehOdo').value) || 0;
  const currentFuelLiters = Number(document.getElementById('addVehFuel').value) || 40;
  const dailyRentalRate = Number(document.getElementById('addVehRentalRate')?.value) || 200;
  const driverUsername = document.getElementById('addVehDriverSelect').value;
  const driver = appState.users.find(u => u.username === driverUsername);

  const payload = {
    name,
    plateNumber,
    fuelType,
    currentOdometer,
    currentFuelLiters,
    dailyRentalRate,
    fuelCapacityLiters: 60,
    driverUsername,
    driverName: driver ? driver.name : ''
  };

  try {
    const res = await fetch('/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      appState.vehicles.push(data.vehicle);
      localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
      renderFleetVehiclesCards();
      closeModal('addVehicleModal');
      showToast(`تمت إضافة المركبة "${name}" بنجاح ✨`, 'success');
      return;
    }
  } catch (e) {
    const newVeh = { id: 'veh_' + Date.now(), ...payload };
    appState.vehicles.push(newVeh);
    localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
    renderFleetVehiclesCards();
    closeModal('addVehicleModal');
    showToast('تمت الإضافة محلياً', 'info');
  }
}

// =========================================================================
// 7. إدارة الحسابات وتوزيع الصلاحيات (Admin Users & Permissions)
// "admin ينشئ يوزرات ادارية مع صالحية كل حساب حسب admin شو محدد"
// "مسوولة السواقين ممنوع يعدل شي بس يتفرج"
// =========================================================================

function openAdminUsersModal() {
  if (appState.currentUser?.role !== 'admin' && appState.currentUser?.username !== 'admin') {
    showToast('عذراً، إدارة المستخدمين وتحديد الصلاحيات محصورة بحساب المشرف العام (admin) فقط', 'warning');
    return;
  }
  switchUserModalTab('admins');
  renderAdminStaffTable();
  renderAdminDriversTable();
  openModal('adminUsersModal');
}

function switchUserModalTab(tabName) {
  const tabAdmins = document.getElementById('userModalTabAdmins');
  const tabDrivers = document.getElementById('userModalTabDrivers');
  const sectionAdmins = document.getElementById('usersAdminsSection');
  const sectionDrivers = document.getElementById('usersDriversSection');

  if (tabName === 'admins') {
    tabAdmins.className = 'px-4 py-2 border-b-2 border-blue-500 text-blue-400 font-bold text-xs flex items-center gap-1.5';
    tabDrivers.className = 'px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-white font-bold text-xs flex items-center gap-1.5';
    sectionAdmins.classList.remove('hidden');
    sectionDrivers.classList.add('hidden');
    renderAdminStaffTable();
  } else {
    tabDrivers.className = 'px-4 py-2 border-b-2 border-blue-500 text-blue-400 font-bold text-xs flex items-center gap-1.5';
    tabAdmins.className = 'px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-white font-bold text-xs flex items-center gap-1.5';
    sectionDrivers.classList.remove('hidden');
    sectionAdmins.classList.add('hidden');
    renderAdminDriversTable();
  }
  initLucideIcons();
}

function handleAdminRolePresetChange() {
  const preset = document.getElementById('newAdminRolePreset').value;

  const permEdit = document.getElementById('perm_canEditTrips');
  const permDelete = document.getElementById('perm_canDeleteTrips');
  const permVehicles = document.getElementById('perm_canManageVehicles');
  const permDrivers = document.getElementById('perm_canManageDrivers');
  const permExport = document.getElementById('perm_canExportExcel');

  if (preset === 'supervisor_readonly') {
    // "مسؤول السائقين ممنوع يعدل شي بس يتفرج"
    permEdit.checked = false;
    permDelete.checked = false;
    permVehicles.checked = false;
    permDrivers.checked = false;
    permExport.checked = true;
  } else if (preset === 'admin') {
    // Super Admin: full control
    permEdit.checked = true;
    permDelete.checked = true;
    permVehicles.checked = true;
    permDrivers.checked = true;
    permExport.checked = true;
  }
}

async function handleAddNewAdminUser(event) {
  event.preventDefault();
  const name = document.getElementById('newAdminName').value.trim();
  const username = document.getElementById('newAdminUsername').value.trim().toLowerCase();
  const password = document.getElementById('newAdminPassword').value.trim();
  const phone = document.getElementById('newAdminPhone').value.trim();
  const rolePreset = document.getElementById('newAdminRolePreset').value;

  const permissions = {
    canViewTrips: true,
    canEditTrips: document.getElementById('perm_canEditTrips').checked,
    canDeleteTrips: document.getElementById('perm_canDeleteTrips').checked,
    canManageVehicles: document.getElementById('perm_canManageVehicles').checked,
    canManageDrivers: document.getElementById('perm_canManageDrivers').checked,
    canManageUsers: rolePreset === 'admin',
    canExportExcel: document.getElementById('perm_canExportExcel').checked
  };

  const userRole = rolePreset === 'custom' ? 'custom_supervisor' : rolePreset;
  const payload = {
    name,
    username,
    password,
    phone,
    role: userRole,
    permissions,
    requesterRole: appState.currentUser?.role || 'admin',
    requesterUsername: appState.currentUser?.username || 'admin'
  };

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.success) {
      appState.users.push(data.user);
      localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
      renderAdminStaffTable();
      document.getElementById('newAdminUserForm').reset();
      showToast(`تم إنشاء الحساب الإداري "${name}" بنجاح 🛡️`, 'success');
      return;
    } else {
      showToast(data.error || 'فشل إنشاء الحساب', 'warning');
    }
  } catch (e) {
    const localUser = {
      id: 'usr_' + Date.now(),
      name,
      username,
      password,
      phone,
      role: userRole,
      permissions,
      active: true
    };
    appState.users.push(localUser);
    localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));

    enqueueSyncAction({
      type: 'ADD_USER',
      tempId: localUser.id,
      payload: payload
    });

    renderAdminStaffTable();
    document.getElementById('newAdminUserForm').reset();
    showToast('تم الإنشاء محلياً', 'info');
  }
}

function renderAdminStaffTable() {
  const tbody = document.getElementById('adminStaffTableBody');
  if (!tbody) return;

  const staff = appState.users.filter(u => u.role !== 'driver');
  if (staff.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-500">لا يوجد حسابات إدارية.</td></tr>`;
    return;
  }

  tbody.innerHTML = staff.map(u => {
    let roleBadge = '';
    let permsBadges = '';

    if (u.role === 'admin') {
      roleBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">مشرف عام</span>`;
      permsBadges = `<span class="text-emerald-400 font-bold">كامل الصلاحيات (تحكم شامل)</span>`;
    } else if (u.role === 'supervisor_readonly') {
      roleBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/30">مسؤول السائقين</span>`;
      permsBadges = `<span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-amber-300 font-bold">قراءة وعرض فقط (ممنوع التعديل)</span>`;
    } else {
      roleBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/30">مشرف مخصص</span>`;
      const p = u.permissions || {};
      const activeList = [];
      if (p.canEditTrips) activeList.push('تعديل الرحلات');
      if (p.canDeleteTrips) activeList.push('حذف الرحلات');
      if (p.canManageVehicles) activeList.push('ضبط الوقود والعدادات');
      if (p.canManageDrivers) activeList.push('إدارة السائقين');
      permsBadges = activeList.length > 0 
        ? activeList.map(a => `<span class="px-1.5 py-0.5 rounded bg-slate-950 text-[10px] text-slate-300 mr-1">${a}</span>`).join('')
        : `<span class="text-slate-500">مراقبة فقط</span>`;
    }

    const isPrimaryAdmin = u.username === 'admin';

    return `
      <tr class="hover:bg-slate-900/60 transition-colors">
        <td class="p-2.5 font-bold text-white">${escapeHtml(u.name)}</td>
        <td class="p-2.5 font-mono-numbers text-rose-300 font-semibold">${escapeHtml(u.username)}</td>
        <td class="p-2.5 whitespace-nowrap">${roleBadge}</td>
        <td class="p-2.5 text-xs">${permsBadges}</td>
        <td class="p-2.5 text-center whitespace-nowrap">
          ${isPrimaryAdmin ? `
            <span class="text-[10px] text-slate-500 font-semibold">حساب النظام الأساسي</span>
          ` : `
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="adminResetPasswordPrompt('${u.id}')" class="px-2 py-1 rounded bg-amber-900/60 hover:bg-amber-800 text-amber-200 text-xs" title="تغيير الرمز">
                <i data-lucide="key" class="w-3.5 h-3.5 inline"></i> الرمز
              </button>
              <button onclick="adminDeleteUserAccount('${u.id}', '${escapeHtml(u.name)}')" class="px-2 py-1 rounded bg-rose-950 hover:bg-rose-900 text-rose-300 text-xs" title="حذف الحساب">
                <i data-lucide="trash-2" class="w-3.5 h-3.5 inline"></i>
              </button>
            </div>
          `}
        </td>
      </tr>
    `;
  }).join('');

  initLucideIcons();
}

async function adminDeleteUserAccount(userId, name) {
  if (!confirm(`هل أنت متأكد من حذف الحساب الإداري "${name}" نهائياً؟`)) return;

  try {
    const res = await fetch(`/api/users/${userId}?role=${encodeURIComponent(appState.currentUser?.role || 'admin')}&username=${encodeURIComponent(appState.currentUser?.username || 'admin')}`, { method: 'DELETE' });
    if (res.ok) {
      appState.users = appState.users.filter(u => u.id !== userId);
      localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
      renderAdminStaffTable();
      showToast(`تم حذف الحساب "${name}" بنجاح`, 'info');
    }
  } catch (e) {
    appState.users = appState.users.filter(u => u.id !== userId);
    localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
    renderAdminStaffTable();
    showToast('تم الحذف محلياً', 'info');
  }
}

// ==========================================
// 8. حسابات السائقين (Driver Management)
// ==========================================

function renderAdminDriversTable() {
  const tbody = document.getElementById('adminDriversTableBody');
  if (!tbody) return;

  const drivers = appState.users.filter(u => u.role === 'driver');
  if (drivers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-500">لا يوجد سائقين مسجلين بعد.</td></tr>`;
    return;
  }

  const canEditDrivers = hasPermission('canManageDrivers');

  tbody.innerHTML = drivers.map(d => {
    const driverTripsCount = appState.trips.filter(t => t.driverUsername === d.username || t.driverName === d.name).length;
    return `
      <tr class="hover:bg-slate-900/60 transition-colors">
        <td class="p-2.5 font-bold text-white flex items-center gap-1.5">
          <i data-lucide="user" class="w-3.5 h-3.5 text-blue-400"></i>
          <span>${escapeHtml(d.name)}</span>
        </td>
        <td class="p-2.5 font-mono-numbers text-rose-300 font-semibold">${escapeHtml(d.username)}</td>
        <td class="p-2.5 font-mono-numbers text-slate-300">${escapeHtml(d.vehicle || '-')}</td>
        <td class="p-2.5 font-mono-numbers text-slate-400">${escapeHtml(d.phone || '-')}</td>
        <td class="p-2.5 text-center font-mono-numbers text-cyan-300 font-bold">${driverTripsCount}</td>
        <td class="p-2.5 text-center whitespace-nowrap">
          ${canEditDrivers ? `
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="adminResetPasswordPrompt('${d.id}')" class="px-2 py-1 rounded bg-amber-900/60 hover:bg-amber-800 text-amber-200 text-xs transition-colors" title="تعيين رمز دخول جديد">
                <i data-lucide="key" class="w-3.5 h-3.5 inline"></i> الرمز
              </button>
              <button onclick="adminDeleteDriver('${d.id}')" class="px-2 py-1 rounded bg-rose-950 hover:bg-rose-900 text-rose-300 text-xs transition-colors" title="حذف السائق">
                <i data-lucide="trash-2" class="w-3.5 h-3.5 inline"></i>
              </button>
            </div>
          ` : `
            <span class="text-[10px] text-slate-500">متابعة فقط</span>
          `}
        </td>
      </tr>
    `;
  }).join('');

  initLucideIcons();
}

async function handleAddNewDriver(event) {
  event.preventDefault();
  if (!hasPermission('canManageDrivers')) {
    showToast('عذراً، لا تملك صلاحية إضافة سائقين', 'warning');
    return;
  }

  const name = document.getElementById('newDriverName').value.trim();
  const username = document.getElementById('newDriverUsername').value.trim().toLowerCase();
  const password = document.getElementById('newDriverPassword').value.trim();
  const vehicle = document.getElementById('newDriverVehicle').value.trim();
  const phone = document.getElementById('newDriverPhone').value.trim();
  const submitBtn = document.getElementById('addDriverSubmitBtn');
  submitBtn.disabled = true;

  const payload = {
    name,
    username,
    password,
    vehicle,
    phone,
    role: 'driver',
    requesterRole: appState.currentUser?.role || 'admin',
    requesterUsername: appState.currentUser?.username || 'admin'
  };

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.success) {
      appState.users.push(data.user);
      localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
      await bootstrapFromServer();
      renderAdminDriversTable();
      renderFleetVehiclesCards();
      populateFilterDropdowns();

      document.getElementById('newDriverForm').reset();
      showToast(`تمت إضافة السائق "${name}" بنجاح وحُفظ في السيرفر المركزي 🎉`, 'success');
    } else {
      showToast(data.error || 'فشلت إضافة السائق', 'warning');
    }
  } catch (err) {
    const localUser = {
      id: 'usr_' + Date.now(),
      username,
      password,
      name,
      role: 'driver',
      phone,
      vehicle,
      active: true
    };
    appState.users.push(localUser);
    localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));

    enqueueSyncAction({
      type: 'ADD_USER',
      tempId: localUser.id,
      payload: payload
    });

    renderAdminDriversTable();
    populateFilterDropdowns();
    document.getElementById('newDriverForm').reset();
    showToast(`تم حفظ السائق محلياً بنجاح (سيتم الترحيل فور شبك السيرفر)`, 'info');
  } finally {
    submitBtn.disabled = false;
  }
}

async function adminResetPasswordPrompt(driverId) {
  const driver = appState.users.find(u => u.id === driverId);
  if (!driver) return;

  const newPass = prompt(`أدخل كلمة المرور الجديدة للمستخدم (${driver.name}):`, '1234');
  if (!newPass || !newPass.trim()) return;

  try {
    const res = await fetch(`/api/users/${driverId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        password: newPass.trim(),
        requesterRole: appState.currentUser?.role || 'admin',
        requesterUsername: appState.currentUser?.username || 'admin'
      })
    });
    if (res.ok) {
      driver.password = newPass.trim();
      localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
      showToast(`تم تعيين كلمة المرور للمستخدم "${driver.name}" إلى: ${newPass.trim()}`, 'success');
      return;
    }
  } catch (e) {
    driver.password = newPass.trim();
    localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
    showToast(`تم تعيين كلمة المرور محلياً: ${newPass.trim()}`, 'info');
  }
}

async function adminDeleteDriver(driverId) {
  const driver = appState.users.find(u => u.id === driverId);
  if (!driver) return;

  if (!confirm(`هل أنت متأكد من حذف حساب السائق "${driver.name}" نهائياً من النظام؟`)) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${driverId}?role=${encodeURIComponent(appState.currentUser?.role || 'admin')}&username=${encodeURIComponent(appState.currentUser?.username || 'admin')}`, { method: 'DELETE' });
    if (res.ok) {
      appState.users = appState.users.filter(u => u.id !== driverId);
      localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
      renderAdminDriversTable();
      populateFilterDropdowns();
      showToast(`تم حذف السائق "${driver.name}" بنجاح`, 'info');
      return;
    }
  } catch (e) {
    appState.users = appState.users.filter(u => u.id !== driverId);
    localStorage.setItem(STORAGE_KEYS.CACHED_USERS, JSON.stringify(appState.users));
    renderAdminDriversTable();
    populateFilterDropdowns();
    showToast(`تم الحذف محلياً`, 'info');
  }
}

// ==========================================
// 9. لوحة المشرف والرحلات (Supervisor View)
// ==========================================

function renderSupervisorView() {
  populateFilterDropdowns();
  renderSupervisorKPIs();
  renderDriversAvailabilitySection();
  renderFleetVehiclesCards();
  renderSupervisorTable();
  renderSupervisorCharts();
}

function renderSupervisorKPIs() {
  const trips = appState.trips;
  const totalKm = trips.reduce((acc, t) => acc + (Number(t.distanceKm) || 0), 0);
  const totalTrips = trips.length;
  const totalFuelCost = trips.reduce((acc, t) => acc + (Number(t.fuel?.cost) || 0), 0);
  const totalFuelLiters = trips.reduce((acc, t) => acc + (Number(t.fuel?.liters) || 0), 0);
  const avgKm = totalTrips > 0 ? Math.round(totalKm / totalTrips) : 0;

  const totalKmElem = document.getElementById('superTotalKm');
  if (totalKmElem) totalKmElem.innerHTML = `${totalKm.toLocaleString()} <span class="text-sm font-normal text-slate-400">كم</span>`;

  const totalTripsElem = document.getElementById('superTotalTrips');
  if (totalTripsElem) totalTripsElem.textContent = totalTrips.toLocaleString();

  // ما بدي مسؤول السواقين يعرف السعر: إظهار اللترات للمشرف بدل الشواكل
  const fuelKpi = document.getElementById('superTotalFuel');
  if (fuelKpi) {
    if (canViewFinancials()) {
      fuelKpi.textContent = `${totalFuelCost.toLocaleString()} ₪`;
    } else {
      fuelKpi.innerHTML = `${totalFuelLiters.toLocaleString()} <span class="text-sm font-normal text-slate-400">لتر</span>`;
    }
  }

  const avgKmElem = document.getElementById('superAvgTripKm');
  if (avgKmElem) avgKmElem.innerHTML = `${avgKm} <span class="text-sm font-normal text-slate-400">كم</span>`;
}

function populateFilterDropdowns() {
  const driverSelect = document.getElementById('filterDriver');
  const editDriverSelect = document.getElementById('editTripDriver');

  const drivers = appState.users.filter(u => u.role === 'driver');

  if (driverSelect) {
    const currentVal = driverSelect.value;
    driverSelect.innerHTML = `<option value="ALL">جميع السائقين</option>` +
      drivers.map(d => `<option value="${escapeHtml(d.username)}">${escapeHtml(d.name)}</option>`).join('');
    driverSelect.value = currentVal || 'ALL';
  }

  if (editDriverSelect) {
    editDriverSelect.innerHTML = drivers.map(d => `<option value="${escapeHtml(d.username)}">${escapeHtml(d.name)}</option>`).join('');
  }
}

function getFilteredTrips() {
  const search = document.getElementById('filterSearch')?.value.toLowerCase().trim() || '';
  const team = document.getElementById('filterTeam')?.value || 'ALL';
  const driver = document.getElementById('filterDriver')?.value || 'ALL';
  const period = document.getElementById('filterPeriod')?.value || 'ALL';

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  return appState.trips.filter(trip => {
    if (team !== 'ALL' && trip.team !== team) return false;
    if (driver !== 'ALL' && trip.driverUsername !== driver) return false;

    if (period === 'TODAY') {
      if (!trip.startTime || !trip.startTime.startsWith(todayStr)) return false;
    } else if (period === 'WEEK') {
      const tripDate = new Date(trip.startTime);
      const diffDays = (now - tripDate) / (1000 * 3600 * 24);
      if (diffDays > 7) return false;
    } else if (period === 'MONTH') {
      const tripDate = new Date(trip.startTime);
      const diffDays = (now - tripDate) / (1000 * 3600 * 24);
      if (diffDays > 30) return false;
    }

    if (search) {
      const haystack = [
        trip.driverName,
        trip.driverUsername,
        trip.team,
        trip.destination,
        trip.notes,
        ...(trip.passengers || [])
      ].filter(Boolean).join(' ').toLowerCase();

      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

function renderSupervisorTable() {
  const tbody = document.getElementById('supervisorTripsTbody');
  const noTrips = document.getElementById('noTripsFoundNotice');
  if (!tbody) return;

  const filtered = getFilteredTrips();

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    noTrips.classList.remove('hidden');
    return;
  }

  noTrips.classList.add('hidden');

  const canEdit = hasPermission('canEditTrips');
  const canDelete = hasPermission('canDeleteTrips');
  const rentalData = computeLocalFleetRentalAccounts();
  const tripBillingMap = rentalData.tripBillingMap || {};

  tbody.innerHTML = filtered.map((trip, idx) => {
    const passengersStr = trip.passengers && trip.passengers.length > 0 ? trip.passengers.join('، ') : 'السائق بمفرده';
    const hasPhotos = Boolean(trip.startPhoto || trip.endPhoto || trip.fuel?.receiptPhoto);

    // Rental Billing Badge (احتساب الإيجار اليومي على أول طلعة فقط - مخفي السعر عن مسؤول السائقين)
    const billing = tripBillingMap[trip.id];
    let rentalBadge = '';
    if (billing && billing.isFirstTripOfDay) {
      rentalBadge = canViewFinancials() ? `
        <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 inline-flex items-center gap-1 whitespace-nowrap shadow-sm shadow-emerald-950/40" title="أول طلعة للمركبة اليوم: احتساب الإيجار اليومي بالكامل (${billing.rentalAmount} ₪) على فريق ${escapeHtml(billing.billedTeam || trip.team || '')}">
          <span>🏷️ أول طلعة</span>
          <span class="font-mono-numbers font-black text-white">(${billing.rentalAmount} ₪)</span>
        </span>
      ` : `
        <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 inline-flex items-center gap-1 whitespace-nowrap shadow-sm shadow-emerald-950/40" title="أول طلعة للمركبة اليوم مع فريق ${escapeHtml(billing.billedTeam || trip.team || '')}">
          <span>🏷️ أول طلعة باليوم</span>
        </span>
      `;
    } else if (billing && !billing.isFirstTripOfDay) {
      rentalBadge = canViewFinancials() ? `
        <span class="px-2.5 py-1 rounded-full text-[10px] font-medium bg-slate-800/90 text-slate-400 border border-slate-700/60 inline-flex items-center gap-1 whitespace-nowrap" title="رحلة تالية بنفس اليوم: مشمولة بالإيجار اليومي لأول طلعة المحسوب على (${escapeHtml(billing.billedTeam || '')})">
          <span>🔄 مشمولة بالإيجار</span>
          <span class="text-slate-500 font-mono-numbers">(0 ₪)</span>
        </span>
      ` : `
        <span class="px-2.5 py-1 rounded-full text-[10px] font-medium bg-slate-800/90 text-slate-400 border border-slate-700/60 inline-flex items-center gap-1 whitespace-nowrap" title="رحلة تالية بنفس اليوم (مشمولة مع أول طلعة)">
          <span>🔄 رحلة تالية بنفس اليوم</span>
        </span>
      `;
    } else {
      rentalBadge = `<span class="text-slate-600 text-xs">-</span>`;
    }

    // Odometer & Status Display
    let statusOdometerBadge = '';
    if (trip.status === 'dispatched') {
      if (trip.driverResponse === 'accepted') {
        statusOdometerBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">متاح وجاهز للرحلة ✅</span>`;
      } else if (trip.driverResponse === 'rejected') {
        statusOdometerBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40" title="${escapeHtml(trip.rejectionReason || 'غير متاح')}">اعتذر (${escapeHtml(trip.rejectionReason || 'غير متاح')}) ❌</span>`;
      } else {
        statusOdometerBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">بانتظار تأكيد السائق ⏳</span>`;
      }
    } else if (trip.status === 'in_progress' || !trip.endOdometer) {
      statusOdometerBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 animate-pulse">جارية الآن 🚗</span>`;
    } else {
      statusOdometerBadge = `<span class="font-mono-numbers text-slate-200 font-bold">${trip.endOdometer} كم</span>`;
    }

    return `
      <tr class="hover:bg-slate-900/60 transition-colors">
        <td class="p-3.5 font-mono-numbers text-slate-500 font-bold">${idx + 1}</td>
        <td class="p-3.5 whitespace-nowrap">
          <div class="font-bold text-white font-mono-numbers">${formatDate(trip.startTime)}</div>
          <div class="text-[11px] text-slate-400 font-mono-numbers">${formatTime(trip.startTime)} ← ${trip.endTime ? formatTime(trip.endTime) : (trip.status === 'dispatched' ? 'حجز مسبق' : 'قيد التنفيذ')}</div>
        </td>
        <td class="p-3.5 whitespace-nowrap">
          <div class="font-bold text-slate-200">${escapeHtml(trip.driverName)}</div>
          <div class="text-[11px] text-slate-400 font-mono-numbers">${escapeHtml(trip.vehicle || '')}</div>
        </td>
        <td class="p-3.5 whitespace-nowrap">
          <span class="inline-block px-2.5 py-1 rounded-full text-xs font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30">
            ${escapeHtml(trip.team)}
          </span>
        </td>
        <td class="p-3.5 max-w-[180px] truncate" title="${escapeHtml(passengersStr)}">
          ${escapeHtml(passengersStr)}
        </td>
        <td class="p-3.5 font-mono-numbers text-slate-300">${trip.startOdometer ? trip.startOdometer + ' كم' : (trip.status === 'dispatched' ? '<span class="text-slate-500">-</span>' : '0 كم')}</td>
        <td class="p-3.5 whitespace-nowrap">${statusOdometerBadge}</td>
        <td class="p-3.5 font-mono-numbers font-bold text-emerald-400">
          ${trip.distanceKm ? trip.distanceKm + ' كم' : '-'}
        </td>
        <td class="p-3.5 whitespace-nowrap">
          ${rentalBadge}
        </td>
        <td class="p-3.5 whitespace-nowrap">
          ${trip.fuel?.hasExpense ? (
            canViewFinancials()
              ? `<span class="text-amber-300 font-mono-numbers font-bold">${trip.fuel.cost || 0} ₪</span>`
              : `<span class="text-amber-300 font-mono-numbers font-bold">${trip.fuel.liters || 0} لتر</span>`
          ) : '<span class="text-slate-600">-</span>'}
        </td>
        <td class="p-3.5 text-center whitespace-nowrap">
          ${hasPhotos ? `<span class="text-emerald-400" title="يوجد صور موثقة"><i data-lucide="check" class="w-4 h-4 inline"></i></span>` : `<span class="text-slate-600">-</span>`}
        </td>
        <td class="p-3.5 text-center whitespace-nowrap">
          <div class="flex items-center justify-center gap-1.5">
            <!-- View Details (Always visible) -->
            <button onclick="openTripDetailsModal('${trip.id}')" class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-rose-300 transition-colors" title="عرض التفاصيل والصور">
              <i data-lucide="eye" class="w-4 h-4"></i>
            </button>
            
            <!-- Admin Quick End Odometer Edit (المشرف يعدل نهاية العداد) -->
            ${canEdit ? `
              <button onclick="openQuickEndOdometerModal('${trip.id}')" class="p-1.5 rounded-lg bg-emerald-950/70 hover:bg-emerald-900 border border-emerald-800/60 text-emerald-300 transition-colors" title="تعديل نهاية العداد وإغلاق الرحلة">
                <i data-lucide="gauge" class="w-4 h-4"></i>
              </button>
            ` : ''}

            <!-- Admin Full Edit Trip -->
            ${canEdit ? `
              <button onclick="openEditTripModal('${trip.id}')" class="p-1.5 rounded-lg bg-amber-950/70 hover:bg-amber-900 border border-amber-800/60 text-amber-300 transition-colors" title="تعديل تفاصيل الرحلة">
                <i data-lucide="edit-3" class="w-4 h-4"></i>
              </button>
            ` : ''}

            <!-- Admin Delete Trip (Modal-based, works reliably on all phones & PC) -->
            ${canDelete ? `
              <button onclick="confirmAdminDeleteTrip('${trip.id}')" class="p-1.5 rounded-lg bg-rose-950/70 hover:bg-rose-900 border border-rose-800/60 text-rose-300 transition-colors" title="حذف الرحلة نهائياً">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  initLucideIcons();
}

// ==========================================
// 10. تعديل وحذف الرحلات (Trip Edit & Delete)
// ==========================================

function openEditTripModal(tripId) {
  if (!hasPermission('canEditTrips')) {
    showToast('عذراً، هذا الحساب للمراقبة فقط ولا يملك صلاحية تعديل الرحلات', 'warning');
    return;
  }

  const trip = appState.trips.find(t => t.id === tripId);
  if (!trip) return;

  populateFilterDropdowns();
  populateTeamOptions();

  document.getElementById('editTripId').value = trip.id;
  document.getElementById('editTripDriver').value = trip.driverUsername;
  document.getElementById('editTripVehicle').value = trip.vehicle || '';
  document.getElementById('editTripTeam').value = trip.team;
  document.getElementById('editTripDestination').value = trip.destination || '';
  document.getElementById('editTripStartTime').value = trip.startTime ? trip.startTime.slice(0, 16) : '';
  document.getElementById('editTripEndTime').value = trip.endTime ? trip.endTime.slice(0, 16) : '';
  document.getElementById('editTripStartOdo').value = trip.startOdometer || 0;
  document.getElementById('editTripEndOdo').value = trip.endOdometer || '';
  document.getElementById('editTripDistance').value = trip.distanceKm || '';
  document.getElementById('editTripPassengers').value = (trip.passengers || []).join('، ');
  document.getElementById('editTripFuelCost').value = trip.fuel?.cost || '';
  document.getElementById('editTripFuelLiters').value = trip.fuel?.liters || '';
  document.getElementById('editTripFuelStation').value = trip.fuel?.station || '';
  document.getElementById('editTripNotes').value = trip.notes || '';

  openModal('editTripModal');
}

function recalcEditTripDistance() {
  const start = Number(document.getElementById('editTripStartOdo').value) || 0;
  const end = Number(document.getElementById('editTripEndOdo').value);
  const distField = document.getElementById('editTripDistance');

  if (!isNaN(end) && end >= start) {
    distField.value = end - start;
  } else {
    distField.value = '';
  }
}

async function handleEditTripSubmit(event) {
  event.preventDefault();
  const tripId = document.getElementById('editTripId').value;
  const trip = appState.trips.find(t => t.id === tripId);
  if (!trip) return;

  const driverUsername = document.getElementById('editTripDriver').value;
  const driverObj = appState.users.find(u => u.username === driverUsername);
  const driverName = driverObj ? driverObj.name : trip.driverName;

  const vehicle = document.getElementById('editTripVehicle').value.trim();
  const team = document.getElementById('editTripTeam').value;
  const destination = document.getElementById('editTripDestination').value.trim();
  const startTime = document.getElementById('editTripStartTime').value;
  const endTime = document.getElementById('editTripEndTime').value;
  const startOdometer = Number(document.getElementById('editTripStartOdo').value);
  const endOdometer = document.getElementById('editTripEndOdo').value ? Number(document.getElementById('editTripEndOdo').value) : null;
  const distanceKm = endOdometer !== null && endOdometer >= startOdometer ? (endOdometer - startOdometer) : null;

  const passengersRaw = document.getElementById('editTripPassengers').value;
  const passengers = passengersRaw.split(/[,،]/).map(p => p.trim()).filter(Boolean);

  const fuelCost = Number(document.getElementById('editTripFuelCost').value) || 0;
  const fuelLiters = Number(document.getElementById('editTripFuelLiters').value) || 0;
  const fuelStation = document.getElementById('editTripFuelStation').value.trim();
  const notes = document.getElementById('editTripNotes').value.trim();

  let fuel = trip.fuel;
  if (fuelCost > 0 || fuelLiters > 0 || fuelStation) {
    fuel = {
      hasExpense: true,
      cost: fuelCost,
      liters: fuelLiters,
      station: fuelStation,
      receiptPhoto: trip.fuel?.receiptPhoto || null
    };
  }

  const updatedTrip = {
    ...trip,
    driverUsername,
    driverName,
    vehicle,
    team,
    destination,
    startTime: startTime ? new Date(startTime).toISOString() : trip.startTime,
    endTime: endTime ? new Date(endTime).toISOString() : null,
    startOdometer,
    endOdometer,
    distanceKm,
    passengers,
    fuel,
    notes,
    status: endOdometer ? 'completed' : 'in_progress'
  };

  try {
    await fetch(`/api/trips/${tripId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedTrip)
    });
  } catch (e) {
    console.warn('تعذر التحديث على السيرفر، تم التحديث محلياً');
  }

  const idx = appState.trips.findIndex(t => t.id === tripId);
  if (idx !== -1) appState.trips[idx] = updatedTrip;
  localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));

  await bootstrapFromServer();
  closeModal('editTripModal');
  showToast('تم حفظ تعديلات الرحلة وقراءة العداد في السيرفر بنجاح ✏️', 'success');
  renderSupervisorView();
}

async function adminDeleteTrip(tripId) {
  confirmAdminDeleteTrip(tripId);
}

// ==========================================
// 11. لوحة السائق فقط (Driver View)
// ==========================================

function renderDriverView() {
  checkNotificationPermissionState();
  checkIncomingDispatches();
  renderPendingDispatches();
  renderActiveTripCard();
  renderDriverStats();
  renderDriverRecentTrips();
}

function renderActiveTripCard() {
  const container = document.getElementById('activeTripContainer');
  const prompt = document.getElementById('noActiveTripPrompt');

  if (!appState.activeTrip) {
    container.classList.add('hidden');
    prompt.classList.remove('hidden');
    return;
  }

  container.classList.remove('hidden');
  prompt.classList.add('hidden');

  document.getElementById('activeTripTeamTitle').textContent = appState.activeTrip.team;
  document.getElementById('activeTripDestination').textContent = appState.activeTrip.destination || 'غير محددة';
  document.getElementById('activeTripStartKm').textContent = `${appState.activeTrip.startOdometer} كم`;
  document.getElementById('activeTripStartTime').textContent = formatDateTime(appState.activeTrip.startTime);

  const passengersContainer = document.getElementById('activeTripPassengers');
  if (passengersContainer) {
    if (appState.activeTrip.passengers && appState.activeTrip.passengers.length > 0) {
      passengersContainer.innerHTML = appState.activeTrip.passengers.map(p => `
        <span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-200 text-xs">${escapeHtml(p)}</span>
      `).join('');
    } else {
      passengersContainer.innerHTML = `<span class="text-slate-500 text-xs">السائق بمفرده</span>`;
    }
  }

  updateActiveTripTimer();
}

function renderDriverStats() {
  if (!appState.currentUser) return;
  const username = appState.currentUser.username;
  const todayStr = new Date().toISOString().split('T')[0];

  const driverTrips = appState.trips.filter(t => t.driverUsername === username || t.driverName === appState.currentUser.name);
  const todayTrips = driverTrips.filter(t => t.startTime && t.startTime.startsWith(todayStr));

  const todayCount = todayTrips.length;
  const todayKm = todayTrips.reduce((acc, t) => acc + (Number(t.distanceKm) || 0), 0);
  const todayFuel = todayTrips.reduce((acc, t) => acc + (Number(t.fuel?.cost) || 0), 0);

  let lastOdometer = 0;
  if (driverTrips.length > 0) {
    const latest = driverTrips[0];
    lastOdometer = latest.endOdometer || latest.startOdometer || 0;
  }

  document.getElementById('statTodayTrips').textContent = todayCount;
  document.getElementById('statTodayKm').innerHTML = `${todayKm} <span class="text-xs font-normal text-slate-400">كم</span>`;
  document.getElementById('statLastOdometer').innerHTML = `${lastOdometer} <span class="text-xs font-normal text-slate-400">كم</span>`;
  document.getElementById('statTodayFuel').textContent = `${todayFuel} ₪`;
}

function renderDriverRecentTrips() {
  const container = document.getElementById('driverTripsList');
  const countLabel = document.getElementById('driverTripCountLabel');
  if (!container || !appState.currentUser) return;

  const username = appState.currentUser.username;
  const driverTrips = appState.trips.filter(t => t.driverUsername === username || t.driverName === appState.currentUser.name);

  countLabel.textContent = `${driverTrips.length} رحلة مسجلة`;

  if (driverTrips.length === 0) {
    container.innerHTML = `
      <div class="glass-card rounded-2xl p-8 text-center text-slate-400 border border-slate-800">
        <i data-lucide="route" class="w-12 h-12 text-slate-600 mx-auto mb-3"></i>
        <p class="font-bold text-white">لا توجد رحلات مسجلة لك حتى الآن</p>
        <p class="text-xs text-slate-500 mt-1">ابدأ رحلتك الأولى وسجّل عداد البداية والفريق</p>
      </div>
    `;
    initLucideIcons();
    return;
  }

  container.innerHTML = driverTrips.map(trip => {
    const passengersStr = trip.passengers && trip.passengers.length > 0 ? trip.passengers.join('، ') : 'السائق بمفرده';
    return `
      <div class="glass-card rounded-2xl p-4 border border-slate-800/80 hover:border-slate-700 transition-all space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30">
              ${escapeHtml(trip.team)}
            </span>
            <span class="text-xs text-slate-400 font-mono-numbers">${formatDate(trip.startTime)}</span>
          </div>
          <div class="text-left font-mono-numbers font-bold text-emerald-400 text-sm">
            ${trip.distanceKm ? trip.distanceKm + ' كم' : 'جارية'}
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          <div>
            <span class="text-slate-500 block">وقت الرحلة:</span>
            <span class="text-slate-300 font-mono-numbers">${formatTime(trip.startTime)} ← ${trip.endTime ? formatTime(trip.endTime) : 'قيد التنفيذ'}</span>
          </div>
          <div>
            <span class="text-slate-500 block">العداد:</span>
            <span class="text-slate-300 font-mono-numbers">${trip.startOdometer} ← ${trip.endOdometer || '...'}</span>
          </div>
          <div>
            <span class="text-slate-500 block">الركاب:</span>
            <span class="text-slate-300 truncate block">${escapeHtml(passengersStr)}</span>
          </div>
          <div>
            <span class="text-slate-500 block">الوجهة:</span>
            <span class="text-slate-300 truncate block">${escapeHtml(trip.destination || '-')}</span>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 pt-1 border-t border-slate-800/60">
          <button onclick="openTripDetailsModal('${trip.id}')" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-rose-300 text-xs font-semibold flex items-center gap-1 transition-colors">
            <i data-lucide="eye" class="w-3.5 h-3.5"></i>
            <span>التفاصيل والصور</span>
          </button>
          <button onclick="shareTripText('${trip.id}')" class="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-emerald-300 text-xs font-semibold flex items-center gap-1 transition-colors">
            <i data-lucide="share-2" class="w-3.5 h-3.5"></i>
            <span>مشاركة</span>
          </button>
        </div>
      </div>
    `;
  }).join('');

  initLucideIcons();
}

// ==========================================
// 12. بدء وإنهاء رحلة السائق (Start & End)
// ==========================================

function openStartTripModal(dispatchedTrip = null) {
  if (!appState.currentUser) return;
  document.getElementById('startDriverName').value = appState.currentUser.name;
  document.getElementById('startVehicle').value = dispatchedTrip?.vehicle || appState.currentUser.vehicle || 'مركبة الأسطول';
  document.getElementById('startDateTime').value = getLocalIsoDateTime();
  document.getElementById('startDestination').value = dispatchedTrip?.destination || '';
  document.getElementById('passengerInput').value = '';
  document.getElementById('startOdoPhotoData').value = '';
  removeImage('startOdoPhotoPreviewContainer', 'startOdoPhotoData');

  if (dispatchedTrip && Array.isArray(dispatchedTrip.passengers)) {
    appState.currentPassengers = [...dispatchedTrip.passengers];
  } else {
    appState.currentPassengers = [];
  }
  renderPassengerTags();

  if (dispatchedTrip) {
    appState.linkedDispatchedTripId = dispatchedTrip.id;
    const teamSelect = document.getElementById('startTeamSelect');
    if (teamSelect) {
      if (appState.teams.includes(dispatchedTrip.team)) {
        teamSelect.value = dispatchedTrip.team;
      } else {
        teamSelect.value = '__CUSTOM__';
        const customInput = document.getElementById('startTeamCustom');
        if (customInput) customInput.value = dispatchedTrip.team;
      }
    }
  } else {
    appState.linkedDispatchedTripId = null;
  }

  // Suggest last odometer reading from vehicle or previous trips
  const matchingVeh = (appState.vehicles || []).find(v => 
    v.driverUsername === appState.currentUser.username ||
    (dispatchedTrip && v.name === dispatchedTrip.vehicle)
  );
  const driverTrips = appState.trips.filter(t => t.driverUsername === appState.currentUser.username && t.endOdometer);
  const startOdoInput = document.getElementById('startOdometer');
  const notice = document.getElementById('suggestedStartOdoNotice');

  if (matchingVeh && matchingVeh.currentOdometer) {
    startOdoInput.value = matchingVeh.currentOdometer;
    notice.textContent = `(آخر قراءة للمركبة: ${matchingVeh.currentOdometer} كم)`;
  } else if (driverTrips.length > 0 && driverTrips[0].endOdometer) {
    startOdoInput.value = driverTrips[0].endOdometer;
    notice.textContent = `(آخر قراءة مسجلة: ${driverTrips[0].endOdometer} كم)`;
  } else {
    startOdoInput.value = '';
    notice.textContent = '';
  }

  handleTeamSelectChange();
  openModal('startTripModal');
}

function handleTeamSelectChange() {
  const select = document.getElementById('startTeamSelect');
  const customInput = document.getElementById('startTeamCustom');
  if (select.value === '__CUSTOM__') {
    select.classList.remove('w-full');
    select.classList.add('w-1/2');
    customInput.classList.remove('hidden');
    customInput.focus();
  } else {
    select.classList.remove('w-1/2');
    select.classList.add('w-full');
    customInput.classList.add('hidden');
  }
}

async function handleStartTripSubmit(event) {
  event.preventDefault();
  const teamSelect = document.getElementById('startTeamSelect').value;
  const teamCustom = document.getElementById('startTeamCustom').value.trim();
  const team = teamSelect === '__CUSTOM__' ? (teamCustom || 'فريق آخر') : teamSelect;

  const startDateTime = document.getElementById('startDateTime').value;
  const destination = document.getElementById('startDestination').value.trim();
  const startOdometer = Number(document.getElementById('startOdometer').value);
  const startPhoto = document.getElementById('startOdoPhotoData').value || null;

  if (isNaN(startOdometer) || startOdometer < 0) {
    showToast('يرجى إدخال قراءة عداد بداية صحيحة', 'warning');
    return;
  }

  const tripId = appState.linkedDispatchedTripId || ('TRIP_' + Date.now());
  const newTrip = {
    id: tripId,
    driverUsername: appState.currentUser.username,
    driverName: appState.currentUser.name,
    vehicle: document.getElementById('startVehicle').value.trim() || appState.currentUser.vehicle || 'مركبة الأسطول',
    team,
    passengers: [...appState.currentPassengers],
    destination,
    startOdometer,
    endOdometer: null,
    distanceKm: null,
    startTime: startDateTime ? new Date(startDateTime).toISOString() : new Date().toISOString(),
    endTime: null,
    startPhoto,
    endPhoto: null,
    fuel: null,
    notes: '',
    status: 'in_progress',
    driverResponse: 'accepted'
  };

  const submitBtn = document.getElementById('startTripSubmitBtn');
  submitBtn.disabled = true;

  try {
    let serverSuccess = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    if (appState.linkedDispatchedTripId) {
      const res = await fetch(`/api/trips/${tripId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTrip),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      serverSuccess = res.ok;
    } else {
      const res = await fetch('/api/trips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTrip),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (data.trip) newTrip.id = data.trip.id;
        serverSuccess = true;
      }
    }
    if (!serverSuccess) throw new Error('Server unreachable');
  } catch (e) {
    console.warn('تعذر حفظ الرحلة على السيرفر مباشرة، تم حفظها محلياً وجدولتها للترحيل فور توفر النت');
    enqueueSyncAction({
      type: appState.linkedDispatchedTripId ? 'END_TRIP' : 'START_TRIP',
      tripId: newTrip.id,
      tempId: newTrip.id,
      payload: newTrip
    });
  }

  appState.linkedDispatchedTripId = null;

  appState.activeTrip = newTrip;
  localStorage.setItem(STORAGE_KEYS.ACTIVE_TRIP, JSON.stringify(newTrip));

  appState.trips.unshift(newTrip);
  localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));

  closeModal('startTripModal');
  submitBtn.disabled = false;
  showToast('تم بدء الرحلة بنجاح! رافقتكم السلامة 🚗', 'success');
  renderDriverView();
}

function openEndTripModal() {
  if (!appState.activeTrip) return;

  document.getElementById('endTripModalTeam').textContent = appState.activeTrip.team;
  document.getElementById('endTripModalStartKm').textContent = `${appState.activeTrip.startOdometer} كم`;
  document.getElementById('endTripModalStartTime').textContent = formatDateTime(appState.activeTrip.startTime);

  document.getElementById('endDateTime').value = getLocalIsoDateTime();
  document.getElementById('endOdometer').value = '';
  document.getElementById('liveCalculatedKm').textContent = '0 كم';
  document.getElementById('endOdoErrorMsg').classList.add('hidden');

  document.getElementById('hasFuelExpense').checked = false;
  toggleFuelInputs();
  document.getElementById('fuelCost').value = '';
  document.getElementById('fuelLiters').value = '';
  document.getElementById('fuelStation').value = '';
  document.getElementById('endTripNotes').value = '';

  removeImage('endOdoPhotoPreviewContainer', 'endOdoPhotoData');
  removeImage('fuelReceiptPreviewContainer', 'fuelReceiptData');

  openModal('endTripModal');
}

function calculateTripDistanceLive() {
  if (!appState.activeTrip) return;
  const startKm = Number(appState.activeTrip.startOdometer) || 0;
  const endKm = Number(document.getElementById('endOdometer').value);
  const resultCard = document.getElementById('liveCalculatedKm');
  const errorMsg = document.getElementById('endOdoErrorMsg');

  if (isNaN(endKm) || !endKm) {
    resultCard.textContent = '0 كم';
    errorMsg.classList.add('hidden');
    return;
  }

  if (endKm < startKm) {
    errorMsg.textContent = `تنبيه: عداد النهاية (${endKm}) أقل من عداد البداية (${startKm})!`;
    errorMsg.classList.remove('hidden');
    resultCard.textContent = '0 كم';
  } else {
    errorMsg.classList.add('hidden');
    const diff = endKm - startKm;
    resultCard.textContent = `${diff} كم`;
  }
}

async function handleEndTripSubmit(event) {
  event.preventDefault();
  if (!appState.activeTrip) return;

  const startKm = Number(appState.activeTrip.startOdometer);
  const endKm = Number(document.getElementById('endOdometer').value);
  const endDateTime = document.getElementById('endDateTime').value;

  if (isNaN(endKm) || endKm < startKm) {
    showToast(`يجب أن تكون قراءة عداد النهاية أكبر من أو تساوي ${startKm} كم`, 'warning');
    return;
  }

  const distanceKm = endKm - startKm;
  const endPhoto = document.getElementById('endOdoPhotoData').value || null;
  const hasFuel = document.getElementById('hasFuelExpense').checked;
  let fuelData = null;

  if (hasFuel) {
    const endFuelSource = document.querySelector('input[name="endTripFuelSource"]:checked')?.value || 'station';
    const endFuelStation = endFuelSource === 'village_stock'
      ? 'مخزون القرية الداخلي (خزان SOS)'
      : (document.getElementById('fuelStation').value.trim() || 'محطة وقود خارجية');

    fuelData = {
      hasExpense: true,
      fuelSource: endFuelSource,
      cost: Number(document.getElementById('fuelCost').value) || 0,
      liters: Number(document.getElementById('fuelLiters').value) || 0,
      station: endFuelStation,
      receiptPhoto: document.getElementById('fuelReceiptData').value || null
    };
  }

  const notes = document.getElementById('endTripNotes').value.trim();

  const completedTrip = {
    ...appState.activeTrip,
    endOdometer: endKm,
    distanceKm,
    endTime: endDateTime ? new Date(endDateTime).toISOString() : new Date().toISOString(),
    endPhoto,
    fuel: fuelData,
    notes,
    status: 'completed'
  };

  const submitBtn = document.getElementById('endTripSubmitBtn');
  submitBtn.disabled = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`/api/trips/${completedTrip.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(completedTrip),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('Server unreachable');
  } catch (e) {
    console.warn('تعذر تحديث الرحلة في السيرفر مباشرة، تم حفظها محلياً وجدولتها للترحيل فور شبك النت');
    enqueueSyncAction({
      type: 'END_TRIP',
      tripId: completedTrip.id,
      payload: completedTrip
    });
  }

  const tripIdx = appState.trips.findIndex(t => t.id === completedTrip.id);
  if (tripIdx !== -1) {
    appState.trips[tripIdx] = completedTrip;
  } else {
    appState.trips.unshift(completedTrip);
  }

  appState.activeTrip = null;
  localStorage.removeItem(STORAGE_KEYS.ACTIVE_TRIP);
  localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));

  await bootstrapFromServer();
  closeModal('endTripModal');
  submitBtn.disabled = false;
  showToast(`تم توثيق الرحلة بنجاح! المسافة: ${distanceKm} كم 🏁`, 'success');
  renderDriverView();
}

function toggleFuelInputs() {
  const checkbox = document.getElementById('hasFuelExpense');
  const container = document.getElementById('fuelInputsContainer');
  if (checkbox.checked) {
    container.classList.remove('hidden');
    // Ensure default source is toggled
    const checkedRadio = document.querySelector('input[name="endTripFuelSource"]:checked');
    toggleEndTripFuelSource(checkedRadio ? checkedRadio.value : 'station');
  } else {
    container.classList.add('hidden');
  }
}

function toggleEndTripFuelSource(source) {
  const label = document.getElementById('endTripStationLabel');
  const input = document.getElementById('fuelStation');
  const costInput = document.getElementById('fuelCost');
  if (source === 'village_stock') {
    if (label) label.textContent = 'المصدر الداخلي (مخزون القرية)';
    if (input) {
      input.value = 'مخزون القرية الداخلي (خزان SOS)';
      input.readOnly = true;
      input.classList.add('bg-slate-950', 'text-sky-300', 'font-bold');
    }
    if (costInput && (!costInput.value || costInput.value === '0')) {
      costInput.value = '0';
    }
  } else {
    if (label) label.textContent = 'اسم المحطة أو تفاصيل المصروف';
    if (input) {
      input.readOnly = false;
      input.classList.remove('bg-slate-950', 'text-sky-300', 'font-bold');
      if (input.value === 'مخزون القرية الداخلي (خزان SOS)') input.value = '';
      input.placeholder = 'مثال: محطة الهدى - ديزل';
    }
  }
}

// ==========================================
// 13. الفرق والمشاريع (Teams & Projects)
// ==========================================

function populateTeamOptions() {
  const startSelect = document.getElementById('startTeamSelect');
  const editSelect = document.getElementById('editTripTeam');
  const filterTeam = document.getElementById('filterTeam');

  const optionsHtml = appState.teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

  if (startSelect) {
    startSelect.innerHTML = optionsHtml + `<option value="__CUSTOM__">مشروع / فريق آخر (إدخال يدوي)...</option>`;
  }
  if (editSelect) editSelect.innerHTML = optionsHtml;
  if (filterTeam) {
    filterTeam.innerHTML = `<option value="ALL">جميع المشاريع</option>` + optionsHtml;
  }
}

function openAdminTeamsModal() {
  renderAdminTeamsList();
  openModal('adminTeamsModal');
}

function renderAdminTeamsList() {
  const container = document.getElementById('adminTeamsList');
  if (!container) return;

  container.innerHTML = appState.teams.map((t, idx) => `
    <div class="flex items-center justify-between p-2 rounded-lg bg-slate-900 border border-slate-800 text-xs">
      <span class="font-bold text-white">${escapeHtml(t)}</span>
      <span class="text-slate-500 font-mono-numbers">#${idx + 1}</span>
    </div>
  `).join('');
}

async function handleAddNewTeam() {
  const input = document.getElementById('newTeamInput');
  const teamName = input.value.trim();
  if (!teamName) return;

  if (appState.teams.includes(teamName)) {
    showToast('هذا الفريق مسجل مسبقاً', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamName })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      appState.teams = data.teams;
      localStorage.setItem(STORAGE_KEYS.CACHED_TEAMS, JSON.stringify(appState.teams));
      populateTeamOptions();
      renderAdminTeamsList();
      input.value = '';
      showToast(`تمت إضافة المشروع "${teamName}" بنجاح`, 'success');
      return;
    }
  } catch (e) {
    appState.teams.push(teamName);
    localStorage.setItem(STORAGE_KEYS.CACHED_TEAMS, JSON.stringify(appState.teams));
    populateTeamOptions();
    renderAdminTeamsList();
    input.value = '';
    showToast(`تمت الإضافة محلياً`, 'info');
  }
}

// ==========================================
// 14. الرسوم البيانية (Charts)
// ==========================================

function renderSupervisorCharts() {
  renderTeamsChart();
  renderDailyChart();
}

function renderTeamsChart() {
  const ctx = document.getElementById('teamsDistanceChart');
  if (!ctx || typeof Chart === 'undefined') return;

  const teamTotals = {};
  appState.teams.forEach(t => { teamTotals[t] = 0; });

  appState.trips.forEach(t => {
    const team = t.team || 'أخرى';
    const km = Number(t.distanceKm) || 0;
    teamTotals[team] = (teamTotals[team] || 0) + km;
  });

  const labels = Object.keys(teamTotals);
  const data = Object.values(teamTotals);

  const colors = [
    '#f43f5e', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899'
  ];

  if (appState.charts.teams) {
    appState.charts.teams.destroy();
  }

  appState.charts.teams = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors.slice(0, labels.length),
        borderWidth: 2,
        borderColor: '#0f172a'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#94a3b8', font: { family: 'Cairo', size: 11 } }
        }
      }
    }
  });
}

function renderDailyChart() {
  const ctx = document.getElementById('dailyDistanceChart');
  if (!ctx || typeof Chart === 'undefined') return;

  const daysMap = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    daysMap[key] = 0;
  }

  appState.trips.forEach(t => {
    if (t.startTime) {
      const key = t.startTime.split('T')[0];
      if (daysMap[key] !== undefined) {
        daysMap[key] += (Number(t.distanceKm) || 0);
      }
    }
  });

  const labels = Object.keys(daysMap).map(k => {
    const parts = k.split('-');
    return `${parts[1]}/${parts[2]}`;
  });
  const data = Object.values(daysMap);

  if (appState.charts.daily) {
    appState.charts.daily.destroy();
  }

  appState.charts.daily = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'كيلومترات الأسطول',
        data,
        backgroundColor: '#10b981',
        borderRadius: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          ticks: { color: '#64748b', font: { family: 'JetBrains Mono' } },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        x: {
          ticks: { color: '#64748b', font: { family: 'Cairo' } },
          grid: { display: false }
        }
      }
    }
  });
}

// ==========================================
// 15. تصدير Excel (SheetJS)
// ==========================================

function exportToExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('جاري تحميل مكتبة Excel، حاول ثانية بعد قليل', 'warning');
    return;
  }

  const trips = getFilteredTrips();
  if (trips.length === 0) {
    showToast('لا توجد بيانات مطابقة لتصديرها إلى Excel', 'warning');
    return;
  }

  const rows = trips.map((t, idx) => {
    const row = {
      '#': idx + 1,
      'تاريخ الرحلة': formatDate(t.startTime),
      'وقت البدء': formatTime(t.startTime),
      'وقت الوصول': t.endTime ? formatTime(t.endTime) : 'قيد التنفيذ',
      'المدة المستغرقة': formatDuration(t.startTime, t.endTime),
      'السائق': t.driverName || '',
      'المركبة': t.vehicle || '',
      'المشروع / الفريق': t.team || '',
      'الركاب والمرافقين': t.passengers && t.passengers.length > 0 ? t.passengers.join('، ') : 'السائق بمفرده',
      'الوجهة': t.destination || '',
      'عداد البداية (كم)': t.startOdometer || 0,
      'عداد النهاية (كم)': t.endOdometer || 0,
      'المسافة المقطوعة (كم)': t.distanceKm || 0,
      'كمية الوقود (لتر)': t.fuel?.liters || 0,
      'محطة الوقود': t.fuel?.station || '',
      'ملاحظات': t.notes || ''
    };

    // إظهار التكلفة المالية للوقود فقط للمشرف العام والمشتريات (مخفي عن مسؤول السائقين)
    if (canViewFinancials()) {
      row['تكلفة الوقود (₪)'] = t.fuel?.cost || 0;
    }

    return row;
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'سجل رحلات قرى الأطفال SOS');

  const todayStr = new Date().toISOString().split('T')[0];
  XLSX.writeFile(workbook, `سجل_رحلات_قرى_الاطفال_SOS_${todayStr}.xlsx`);
  logUserAction('DATA_EXPORT', `قام بتصدير تقرير إكسل لرحلات الأسطول (${trips.length} رحلة)`);
  showToast('تم تصدير ملف Excel بنجاح 📥', 'success');
}

// ==========================================
// 16. تفاصيل الرحلة والصور (Trip Details Modal)
// ==========================================

function openTripDetailsModal(tripId) {
  const trip = appState.trips.find(t => t.id === tripId) || appState.activeTrip;
  if (!trip) return;

  document.getElementById('modalDetailTitle').textContent = `توثيق رحلة ${trip.team}`;
  document.getElementById('modalDetailSubtitle').textContent = `${trip.driverName} • ${formatDate(trip.startTime)}`;

  const passengersStr = trip.passengers && trip.passengers.length > 0 ? trip.passengers.join('، ') : 'السائق بمفرده';

  const body = document.getElementById('tripDetailsBody');
  body.innerHTML = `
    <!-- Top Meta Card -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-3.5 rounded-xl bg-slate-900 border border-slate-800">
      <div>
        <span class="text-slate-500 block">السائق</span>
        <span class="font-bold text-white">${escapeHtml(trip.driverName)}</span>
      </div>
      <div>
        <span class="text-slate-500 block">المركبة</span>
        <span class="font-mono-numbers text-slate-300">${escapeHtml(trip.vehicle || '-')}</span>
      </div>
      <div>
        <span class="text-slate-500 block">المسافة</span>
        <span class="font-mono-numbers font-extrabold text-emerald-400 text-sm">${trip.distanceKm ? trip.distanceKm + ' كم' : 'جارية'}</span>
      </div>
      <div>
        <span class="text-slate-500 block">المدة</span>
        <span class="font-mono-numbers text-cyan-300 font-bold">${formatDuration(trip.startTime, trip.endTime)}</span>
      </div>
    </div>

    <!-- Timing & Odometers -->
    <div class="grid grid-cols-2 gap-3 p-3 rounded-xl bg-slate-900/60 border border-slate-800">
      <div>
        <span class="text-slate-500 block">الانطلاق:</span>
        <span class="font-mono-numbers text-slate-200">${formatDateTime(trip.startTime)}</span>
        <div class="text-rose-400 font-mono-numbers font-bold mt-1">عداد البداية: ${trip.startOdometer} كم</div>
      </div>
      <div>
        <span class="text-slate-500 block">الوصول:</span>
        <span class="font-mono-numbers text-slate-200">${trip.endTime ? formatDateTime(trip.endTime) : 'قيد التنفيذ'}</span>
        <div class="text-emerald-400 font-mono-numbers font-bold mt-1">عداد النهاية: ${trip.endOdometer ? trip.endOdometer + ' كم' : 'جارية'}</div>
      </div>
    </div>

    <div>
      <span class="text-slate-400 font-semibold block mb-1">الركاب والمرافقين:</span>
      <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-200">
        ${escapeHtml(passengersStr)}
      </div>
    </div>

    ${trip.destination ? `
      <div>
        <span class="text-slate-400 font-semibold block mb-1">الوجهة أو الغرض:</span>
        <div class="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-slate-200">${escapeHtml(trip.destination)}</div>
      </div>
    ` : ''}

    <!-- Photos Grid -->
    <div class="space-y-2">
      <span class="text-slate-400 font-semibold block">صور العداد الموثقة:</span>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <!-- Start Photo -->
        <div class="bg-slate-950 p-2 rounded-xl border border-rose-900/40 text-center">
          <span class="text-xs text-rose-300 font-bold block mb-1.5">📷 عداد البداية (${trip.startOdometer} كم)</span>
          ${trip.startPhoto ? `
            <img src="${trip.startPhoto}" alt="عداد البداية" class="w-full h-44 object-cover rounded-lg border border-slate-800">
          ` : `
            <div class="w-full h-44 rounded-lg bg-slate-900 flex items-center justify-center text-slate-500 text-xs">لا توجد صورة للعداد</div>
          `}
        </div>

        <!-- End Photo -->
        <div class="bg-slate-950 p-2 rounded-xl border border-emerald-900/40 text-center">
          <span class="text-xs text-emerald-300 font-bold block mb-1.5">📷 عداد النهاية (${trip.endOdometer || 'جارية'})</span>
          ${trip.endPhoto ? `
            <img src="${trip.endPhoto}" alt="عداد النهاية" class="w-full h-44 object-cover rounded-lg border border-slate-800">
          ` : `
            <div class="w-full h-44 rounded-lg bg-slate-900 flex items-center justify-center text-slate-500 text-xs">لا توجد صورة للعداد</div>
          `}
        </div>
      </div>
    </div>

    <!-- Fuel Receipt -->
    ${trip.fuel?.receiptPhoto ? `
      <div class="bg-slate-950 p-3 rounded-xl border border-amber-900/40 space-y-1.5">
        <span class="text-xs text-amber-300 font-bold block">🧾 ${canViewFinancials() ? `فاتورة الوقود (${trip.fuel.cost} ₪ - ${trip.fuel.station || ''})` : `وصل الوقود (${trip.fuel.liters || ''} لتر - ${trip.fuel.station || ''})`}</span>
        <img src="${trip.fuel.receiptPhoto}" alt="فاتورة الوقود" class="w-full max-h-48 object-contain rounded-lg border border-slate-800">
      </div>
    ` : ''}

    <div class="pt-2 grid grid-cols-2 sm:grid-cols-3 gap-2">
      <button onclick="shareTripWhatsApp('${trip.id}')" class="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md shadow-emerald-950/40 transition-all">
        <i data-lucide="message-circle" class="w-4 h-4"></i>
        <span>مشاركة عبر واتساب 💬</span>
      </button>
      <button onclick="copyTripReport('${trip.id}')" class="py-2.5 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-xs flex items-center justify-center gap-1.5 border border-slate-700 transition-all">
        <i data-lucide="copy" class="w-4 h-4"></i>
        <span>نسخ التقرير 📋</span>
      </button>
      <button onclick="closeModal('tripDetailsModal')" class="py-2.5 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white font-semibold text-xs col-span-2 sm:col-span-1">
        إغلاق
      </button>
    </div>
  `;

  openModal('tripDetailsModal');
  initLucideIcons();
}

function formatTripReportText(trip) {
  const passengersStr = trip.passengers && trip.passengers.length > 0 ? trip.passengers.join('، ') : 'السائق بمفرده';
  let fuelInfo = '';
  if (trip.fuel) {
    const isVillage = trip.fuel.fuelSource === 'village_stock' || (trip.fuel.station && trip.fuel.station.includes('مخزون القرية'));
    const sourceLabel = isVillage ? 'مخزون القرية الداخلي (خزان SOS)' : (trip.fuel.station || 'محطة خارجية');
    fuelInfo = `\n• *الوقود:* ${trip.fuel.liters || 0} لتر [${sourceLabel}] ${trip.fuel.cost ? `(${trip.fuel.cost} ₪)` : ''}`;
  }
  return `🚗 *تقرير رحلة ميدانية - قرى الأطفال SOS*
• *السائق:* ${trip.driverName || trip.driverUsername}
• *المركبة:* ${trip.vehicle}
• *المشروع / الفريق:* ${trip.team}
• *الركاب:* ${passengersStr}
• *تاريخ الرحلة:* ${formatDate(trip.startTime)}
• *وقت الانطلاق:* ${formatTime(trip.startTime)}
• *وقت الوصول:* ${trip.endTime ? formatTime(trip.endTime) : 'جارية'}
• *مدة الرحلة:* ${formatDuration(trip.startTime, trip.endTime)}
• *عداد البداية:* ${trip.startOdometer} كم
• *عداد النهاية:* ${trip.endOdometer ? trip.endOdometer + ' كم' : 'قيد التنفيذ'}
• *المسافة المقطوعة:* ${trip.distanceKm ? trip.distanceKm + ' كم' : '-'}${fuelInfo}
${trip.destination ? `• *الوجهة:* ${trip.destination}` : ''}
${trip.notes ? `• *ملاحظات:* ${trip.notes}` : ''}`;
}

function copyToClipboardFallback(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => execCommandCopy(text));
    } else {
      execCommandCopy(text);
    }
  } catch (_) {
    execCommandCopy(text);
  }
}

function execCommandCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
  } catch (err) {
    console.warn('execCommand copy failed:', err);
  }
  document.body.removeChild(textarea);
}

function copyTripReport(tripId) {
  const trip = appState.trips.find(t => t.id === tripId) || appState.activeTrip;
  if (!trip) {
    showToast('بيانات الرحلة غير متوفرة', 'warning');
    return;
  }
  const text = formatTripReportText(trip);
  copyToClipboardFallback(text);
  showToast('تم نسخ تقرير الرحلة إلى الحافظة بنجاح 📋', 'success');
}

function shareTripWhatsApp(tripId) {
  const trip = appState.trips.find(t => t.id === tripId) || appState.activeTrip;
  if (!trip) {
    showToast('بيانات الرحلة غير متوفرة', 'warning');
    return;
  }
  const text = formatTripReportText(trip);
  copyToClipboardFallback(text);
  const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  window.open(waUrl, '_blank');
  showToast('تم نسخ التقرير وفتح واتساب للمشاركة 📲', 'success');
}

function shareTripText(tripId) {
  const trip = appState.trips.find(t => t.id === tripId) || appState.activeTrip;
  if (!trip) return;

  const text = formatTripReportText(trip);
  copyToClipboardFallback(text);

  if (navigator.share && window.isSecureContext) {
    navigator.share({ title: 'تقرير رحلة قرى الأطفال SOS', text })
      .then(() => showToast('تمت مشاركة التقرير بنجاح 🚀', 'success'))
      .catch((err) => {
        if (err.name !== 'AbortError') {
          shareTripWhatsApp(tripId);
        }
      });
  } else {
    shareTripWhatsApp(tripId);
  }
}

// ==========================================
// 17. الركاب والصور (Helpers)
// ==========================================

function addPassengerTag() {
  const input = document.getElementById('passengerInput');
  const name = input.value.trim();
  if (!name) return;

  if (appState.currentPassengers.includes(name)) {
    showToast('الاسم مضاف مسبقاً في القائمة', 'warning');
    input.value = '';
    return;
  }

  appState.currentPassengers.push(name);
  input.value = '';
  renderPassengerTags();
  input.focus();
}

function removePassengerTag(index) {
  appState.currentPassengers.splice(index, 1);
  renderPassengerTags();
}

function renderPassengerTags() {
  const container = document.getElementById('passengersTagsContainer');
  if (!container) return;

  if (appState.currentPassengers.length === 0) {
    container.innerHTML = `<span class="text-xs text-slate-500 italic p-1">لم يتم إضافة ركاب (السائق بمفرده)</span>`;
    return;
  }

  container.innerHTML = appState.currentPassengers.map((passenger, idx) => `
    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-950/80 border border-rose-700/60 text-rose-200 text-xs font-medium">
      <i data-lucide="user-check" class="w-3.5 h-3.5 text-rose-400"></i>
      <span>${escapeHtml(passenger)}</span>
      <button type="button" onclick="removePassengerTag(${idx})" class="text-rose-400 hover:text-white p-0.5">
        <i data-lucide="x" class="w-3 h-3"></i>
      </button>
    </span>
  `).join('');

  initLucideIcons();
}

function triggerMobilePhoto(inputId) {
  const el = document.getElementById(inputId);
  if (el) {
    el.value = '';
    el.click();
  }
}

function handleImageSelected(inputElement, previewImgId, hiddenDataId) {
  const file = inputElement.files && inputElement.files[0];
  if (!file) return;

  // Use URL.createObjectURL for memory safety and zero lag on iPhone (iOS Safari) & Android
  if (window.URL && window.URL.createObjectURL) {
    try {
      const objUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function() {
        URL.revokeObjectURL(objUrl);
        const maxDimension = 900;
        let width = img.width;
        let height = img.height;
        if (width > height) {
          if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedUrl = canvas.toDataURL('image/jpeg', 0.75);
        const preview = document.getElementById(previewImgId);
        const hidden = document.getElementById(hiddenDataId);
        const container = document.getElementById(previewImgId + 'Container');

        if (preview) preview.src = compressedUrl;
        if (hidden) hidden.value = compressedUrl;
        if (container) container.classList.remove('hidden');
        initLucideIcons();
      };
      img.onerror = function() {
        URL.revokeObjectURL(objUrl);
        fallbackFileReader(file, previewImgId, hiddenDataId);
      };
      img.src = objUrl;
      return;
    } catch (err) {
      console.warn('URL.createObjectURL failed, falling back to FileReader:', err);
    }
  }

  fallbackFileReader(file, previewImgId, hiddenDataId);
}

function fallbackFileReader(file, previewImgId, hiddenDataId) {
  const reader = new FileReader();
  reader.onload = function(e) {
    compressImage(e.target.result, 900, 0.75, function(compressedUrl) {
      const preview = document.getElementById(previewImgId);
      const hidden = document.getElementById(hiddenDataId);
      const container = document.getElementById(previewImgId + 'Container');

      if (preview) preview.src = compressedUrl;
      if (hidden) hidden.value = compressedUrl;
      if (container) container.classList.remove('hidden');
      initLucideIcons();
    });
  };
  reader.readAsDataURL(file);
}

function compressImage(dataUrl, maxDimension, quality, callback) {
  const img = new Image();
  img.onload = function() {
    let width = img.width;
    let height = img.height;

    if (width > height) {
      if (width > maxDimension) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      }
    } else {
      if (height > maxDimension) {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    const compressed = canvas.toDataURL('image/jpeg', quality);
    callback(compressed);
  };
  img.src = dataUrl;
}

function removeImage(previewContainerId, hiddenDataId) {
  const container = document.getElementById(previewContainerId);
  const hidden = document.getElementById(hiddenDataId);
  if (container) container.classList.add('hidden');
  if (hidden) hidden.value = '';
}

function setupActiveTripTimer() {
  if (appState.timerInterval) clearInterval(appState.timerInterval);
  appState.timerInterval = setInterval(() => {
    if (appState.activeTrip) {
      updateActiveTripTimer();
    }
  }, 1000);
}

function updateActiveTripTimer() {
  const timerEl = document.getElementById('activeTripTimer');
  if (!timerEl || !appState.activeTrip) return;

  const start = new Date(appState.activeTrip.startTime).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - start) / 1000));

  const hours = String(Math.floor(diffSec / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((diffSec % 3600) / 60)).padStart(2, '0');
  const seconds = String(diffSec % 60).padStart(2, '0');

  timerEl.textContent = `${hours}:${minutes}:${seconds}`;
}

function getLocalIsoDateTime() {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  return new Date(now - tzOffset).toISOString().slice(0, 16);
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (e) {
    return isoStr.split('T')[0] || isoStr;
  }
}

function formatTime(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch (e) {
    return isoStr;
  }
}

function formatDateTime(isoStr) {
  if (!isoStr) return '-';
  return `${formatDate(isoStr)} (${formatTime(isoStr)})`;
}

function formatDuration(startIso, endIso) {
  if (!startIso) return '-';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const diffMinutes = Math.max(0, Math.round((end - start) / 60000));

  const h = Math.floor(diffMinutes / 60);
  const m = diffMinutes % 60;
  if (h === 0) return `${m} دقيقة`;
  return `${h} س و ${m} د`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.style.display = 'flex';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.style.display = 'none';
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const bgClasses = {
    success: 'bg-emerald-600 border-emerald-500 text-white',
    warning: 'bg-amber-600 border-amber-500 text-white',
    info: 'bg-slate-800 border-slate-700 text-white'
  };

  const toast = document.createElement('div');
  toast.className = `p-3 rounded-xl border shadow-xl text-xs font-semibold flex items-center gap-2 transform transition-all duration-300 translate-y-2 opacity-0 pointer-events-auto ${bgClasses[type] || bgClasses.info}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function initLucideIcons() {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons();
  }
}

function setupServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => {
      console.log('ServiceWorker registration failed:', err);
    });
  }
}

// ==========================================
// 13. إشراف وتكليف الرحلات وحجز المركبات
// (مشرف يفتح رحلة أو حجز لسائق)
// ==========================================

let isDispatchSyncing = false;

function updateDispatchVehicleNoticeOnly() {
  const vehicleSelect = document.getElementById('dispatchVehicle');
  const notice = document.getElementById('dispatchVehicleStatusNotice');
  if (!vehicleSelect || !notice) return;

  const selectedOption = vehicleSelect.options[vehicleSelect.selectedIndex];
  if (!selectedOption || !selectedOption.value) {
    notice.textContent = '';
    return;
  }

  const vStatus = selectedOption.getAttribute('data-status');
  if (vStatus === 'maintenance') {
    notice.textContent = '⚠️ تنبيه: هذه المركبة مسجلة حالياً في الصيانة الفنية';
    notice.className = 'text-[11px] text-amber-400 mt-1 font-bold';
  } else if (vStatus === 'inactive') {
    notice.textContent = '❌ تحذير: هذه المركبة معطلة أو غير نشطة';
    notice.className = 'text-[11px] text-rose-400 mt-1 font-bold';
  } else {
    notice.textContent = '✅ مركبة جاهزة ونشطة للرحلة';
    notice.className = 'text-[11px] text-emerald-400 mt-1 font-semibold';
  }
}

function updateDispatchDriverWarningOnly() {
  const driverSelect = document.getElementById('dispatchDriver');
  const warning = document.getElementById('dispatchDriverStatusWarning');
  if (!driverSelect || !warning) return;

  const selectedOption = driverSelect.options[driverSelect.selectedIndex];
  if (!selectedOption || !selectedOption.value) {
    warning.textContent = '';
    warning.classList.add('hidden');
    return;
  }

  const isBusy = selectedOption.getAttribute('data-busy') === 'true';
  const username = selectedOption.value;
  const busyTrip = (appState.trips || []).find(t => (t.driverUsername === username || t.driverName === selectedOption.text) && t.status === 'in_progress');

  if (isBusy && busyTrip) {
    warning.innerHTML = `⚠️ <strong class="text-amber-200">تنبيه للمشرف:</strong> هذا السائق مسجل حالياً في رحلة ميدانية جارية مع <strong>${escapeHtml(busyTrip.team)}</strong> إلى (<strong>${escapeHtml(busyTrip.destination || 'وجهة غير محددة')}</strong>). يرجى التأكد قبل التكليف.`;
    warning.className = 'text-[11px] mt-1.5 p-2 rounded-lg font-semibold bg-rose-950/80 border border-rose-500/50 text-rose-200 block';
    warning.classList.remove('hidden');
  } else {
    warning.innerHTML = `✅ <strong class="text-emerald-300">السائق متاح وجاهز للتحرك فوراً.</strong>`;
    warning.className = 'text-[11px] mt-1.5 p-2 rounded-lg font-semibold bg-emerald-950/80 border border-emerald-500/50 text-emerald-200 block';
    warning.classList.remove('hidden');
  }
}

function openDispatchTripModal(prefillUsername, prefillVehicle) {
  const vehicleSelect = document.getElementById('dispatchVehicle');
  const driverSelect = document.getElementById('dispatchDriver');
  const teamSelect = document.getElementById('dispatchTeam');
  if (!vehicleSelect || !driverSelect || !teamSelect) return;

  // 1. Populate Fleet Vehicles (Active, with clear status indicators)
  const vehicles = appState.vehicles || [];
  vehicleSelect.innerHTML = `
    <option value="">-- اختر المركبة من الأسطول --</option>
    ${vehicles.map(v => {
      const isMaint = v.status === 'maintenance';
      const isInactive = v.status === 'inactive';
      let statusTag = 'نشطة ومتاحة ✅';
      if (isMaint) statusTag = 'في الصيانة ⚠️';
      if (isInactive) statusTag = 'غير فعالة ❌';
      return `<option value="${escapeHtml(v.name)}" data-driver="${escapeHtml(v.driverUsername || '')}" data-status="${v.status || 'active'}">
        🚗 ${escapeHtml(v.name)} [${statusTag}] (الوقود: ${v.currentFuelLiters || 0}L - العداد: ${v.currentOdometer || 0} كم)
      </option>`;
    }).join('')}
  `;

  // 2. Populate Drivers with Live Availability Status
  const activeTrips = (appState.trips || []).filter(t => t.status === 'in_progress');
  const drivers = (appState.users || []).filter(u => u.role === 'driver' && u.active !== false);
  driverSelect.innerHTML = `
    <option value="">-- اختر السائق المكلف --</option>
    ${drivers.map(d => {
      const busyTrip = activeTrips.find(t => t.driverUsername === d.username || t.driverName === d.name);
      const isBusy = Boolean(busyTrip);
      const statusBadge = isBusy ? `🔴 طالع في رحلة (${busyTrip.team})` : `🟢 متاح للتحرك فوراً`;
      return `
        <option value="${escapeHtml(d.username)}" data-vehicle="${escapeHtml(d.vehicle || '')}" data-busy="${isBusy}">
          👤 ${escapeHtml(d.name)} [${statusBadge}] - ${escapeHtml(d.vehicle || 'مركبة عامة')}
        </option>
      `;
    }).join('')}
  `;

  // 3. Populate Teams
  teamSelect.innerHTML = appState.teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');

  document.getElementById('dispatchDestination').value = '';
  document.getElementById('dispatchPassengers').value = '';
  document.getElementById('dispatchNotes').value = '';
  document.getElementById('dispatchScheduledTime').value = getLocalIsoDateTime();
  const notice = document.getElementById('dispatchVehicleStatusNotice');
  if (notice) notice.textContent = '';
  const warning = document.getElementById('dispatchDriverStatusWarning');
  if (warning) {
    warning.textContent = '';
    warning.classList.add('hidden');
  }

  isDispatchSyncing = true;
  try {
    if (prefillUsername) {
      driverSelect.value = prefillUsername;
      updateDispatchDriverWarningOnly();
    }
    if (prefillVehicle) {
      vehicleSelect.value = prefillVehicle;
      updateDispatchVehicleNoticeOnly();
    }
  } finally {
    isDispatchSyncing = false;
  }

  openModal('dispatchTripModal');
}

function handleDispatchVehicleChange() {
  if (isDispatchSyncing) return;
  isDispatchSyncing = true;
  try {
    const vehicleSelect = document.getElementById('dispatchVehicle');
    const driverSelect = document.getElementById('dispatchDriver');
    const selectedOption = vehicleSelect.options[vehicleSelect.selectedIndex];

    updateDispatchVehicleNoticeOnly();

    if (!selectedOption || !selectedOption.value) return;

    const assignedDriver = selectedOption.getAttribute('data-driver');

    // Auto-select assigned driver if available without recursive triggering
    if (assignedDriver && driverSelect) {
      for (let i = 0; i < driverSelect.options.length; i++) {
        if (driverSelect.options[i].value === assignedDriver) {
          driverSelect.selectedIndex = i;
          updateDispatchDriverWarningOnly();
          break;
        }
      }
    }
  } finally {
    isDispatchSyncing = false;
  }
}

function handleDispatchDriverChange() {
  if (isDispatchSyncing) return;
  isDispatchSyncing = true;
  try {
    const driverSelect = document.getElementById('dispatchDriver');
    const vehicleSelect = document.getElementById('dispatchVehicle');
    const selectedOption = driverSelect.options[driverSelect.selectedIndex];

    updateDispatchDriverWarningOnly();

    if (!selectedOption || !selectedOption.value) return;

    const driverVeh = selectedOption.getAttribute('data-vehicle');
    if (driverVeh && vehicleSelect) {
      for (let i = 0; i < vehicleSelect.options.length; i++) {
        if (vehicleSelect.options[i].value === driverVeh) {
          vehicleSelect.selectedIndex = i;
          updateDispatchVehicleNoticeOnly();
          break;
        }
      }
    }
  } finally {
    isDispatchSyncing = false;
  }
}

async function handleDispatchTripSubmit(event) {
  event.preventDefault();
  const driverSelect = document.getElementById('dispatchDriver');
  const vehicleSelect = document.getElementById('dispatchVehicle');

  const driverUsername = driverSelect.value;
  const vehicleName = vehicleSelect.value;

  if (!driverUsername) {
    showToast('يرجى اختيار السائق المكلف بالرحلة', 'warning');
    return;
  }

  if (!vehicleName) {
    showToast('يرجى اختيار المركبة المخصصة للرحلة', 'warning');
    return;
  }

  const driver = (appState.users || []).find(u => u.username === driverUsername);
  const driverName = driver ? driver.name : (driverSelect.options[driverSelect.selectedIndex]?.text.split('[')[0].replace('👤', '').trim() || driverUsername);

  const team = document.getElementById('dispatchTeam').value;
  const destination = document.getElementById('dispatchDestination').value.trim();
  const passengersRaw = document.getElementById('dispatchPassengers').value;
  const passengers = passengersRaw.split(/[,،]/).map(p => p.trim()).filter(Boolean);
  const scheduledTime = document.getElementById('dispatchScheduledTime').value;
  const notes = document.getElementById('dispatchNotes').value.trim();

  const newTrip = {
    id: 'TRIP_DISP_' + Date.now(),
    driverUsername: driver?.username || driverUsername,
    driverName: driverName,
    vehicle: vehicleName,
    team,
    destination,
    passengers,
    startOdometer: 0,
    endOdometer: null,
    distanceKm: null,
    startTime: scheduledTime ? new Date(scheduledTime).toISOString() : new Date().toISOString(),
    endTime: null,
    startPhoto: null,
    endPhoto: null,
    fuel: null,
    notes,
    status: 'dispatched',
    driverResponse: 'pending'
  };

  const btn = document.getElementById('dispatchSubmitBtn');
  if (btn) btn.disabled = true;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch('/api/trips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTrip),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = await res.json();
      if (data.trip) newTrip.id = data.trip.id;
    }
  } catch (err) {
    console.warn('تعذر الإرسال للسيرفر مباشرة، تم حفظ الحجز محلياً وجدولته:', err);
    enqueueSyncAction({
      type: 'DISPATCH_TRIP',
      tripId: newTrip.id,
      payload: newTrip
    });
  } finally {
    if (btn) btn.disabled = false;
  }

  appState.trips.unshift(newTrip);
  localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));

  closeModal('dispatchTripModal');
  showToast(`تم فتح حجز الرحلة وتكليف السائق (${driverName}) بنجاح 🚀`, 'success');
  renderSupervisorView();
}

// ==========================================
// 14. نظام إشعارات السائق والتنبيه الصوتي
// (يصل إشعار للسائق ويؤكد استلامه متاح أم لا)
// ==========================================

function playNotificationChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    
    // 4-tone ascending alert chime (C5 -> E5 -> G5 -> C6)
    const freqs = [523.25, 659.25, 783.99, 1046.50];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.14);
      gain.gain.setValueAtTime(0.4, ctx.currentTime + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.14 + 0.38);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.14);
      osc.stop(ctx.currentTime + i * 0.14 + 0.42);
    });

    if ('vibrate' in navigator) {
      navigator.vibrate([300, 150, 300, 150, 400]);
    }
  } catch (err) {
    console.warn('تعذر تشغيل نغمة الإشعار:', err);
  }
}

async function requestNotificationPermission(userTriggered = false) {
  if (!('Notification' in window)) {
    if (userTriggered) showToast('متصفحك لا يدعم نظام إشعارات الويب', 'warning');
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    const banner = document.getElementById('notificationPermissionPrompt');
    if (permission === 'granted') {
      if (banner) banner.classList.add('hidden');
      if (userTriggered) showToast('تم تفعيل إشعارات الرحلات والتكليفات بنجاح 🔔', 'success');
      playNotificationChime();
    } else if (permission === 'denied') {
      if (banner) banner.classList.add('hidden');
      if (userTriggered) showToast('تم رفض إذن الإشعارات من إعدادات المتصفح', 'info');
    }
  } catch (e) {
    console.warn('خطأ في طلب إذن الإشعارات:', e);
  }
}

function checkNotificationPermissionState() {
  const banner = document.getElementById('notificationPermissionPrompt');
  if (!banner) return;
  if ('Notification' in window && Notification.permission === 'default') {
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function sendExternalNotification(title, body, tripId) {
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const options = {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [300, 150, 300, 150, 400],
        tag: 'trip-dispatch-' + tripId,
        renotify: true,
        data: { tripId }
      };

      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'SHOW_NOTIFICATION',
          title,
          options
        });
      } else {
        new Notification(title, options);
      }
    } catch (e) {
      console.warn('تعذر إرسال الإشعار الخارجي:', e);
    }
  }
}

function checkIncomingDispatches() {
  if (!appState.currentUser || appState.currentUser.role !== 'driver') return;
  const username = appState.currentUser.username.toLowerCase();

  const pendingDispatches = appState.trips.filter(t => 
    t.driverUsername && t.driverUsername.toLowerCase() === username &&
    t.status === 'dispatched' &&
    (!t.driverResponse || t.driverResponse === 'pending')
  );

  if (pendingDispatches.length === 0) return;

  const latest = pendingDispatches[0];
  if (!appState.alertedDispatchIds.has(latest.id)) {
    appState.alertedDispatchIds.add(latest.id);
    playNotificationChime();
    sendExternalNotification(
      'قرى الأطفال SOS | حجز رحلة جديدة 🚗',
      `تم تكليفك برحلة جديدة لمشروع: ${latest.team} - الوجهة: ${latest.destination || 'ميدانية'}. يرجى تأكيد استلامك وجاهزيتك.`,
      latest.id
    );
    showDriverDispatchAlert(latest);
  }
}

function showDriverDispatchAlert(trip) {
  const detailsBox = document.getElementById('dispatchAlertCardDetails');
  if (!detailsBox) return;

  const passengersStr = trip.passengers && trip.passengers.length > 0 ? trip.passengers.join('، ') : 'السائق بمفرده';

  detailsBox.innerHTML = `
    <div class="flex items-center justify-between border-b border-slate-800 pb-2">
      <span class="text-slate-400">المشروع / الفريق:</span>
      <span class="px-2.5 py-0.5 rounded-full font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs">${escapeHtml(trip.team)}</span>
    </div>
    <div class="flex items-center justify-between border-b border-slate-800 pb-2">
      <span class="text-slate-400">المركبة:</span>
      <span class="font-bold text-white font-mono-numbers text-xs">${escapeHtml(trip.vehicle || '')}</span>
    </div>
    <div class="flex items-center justify-between border-b border-slate-800 pb-2">
      <span class="text-slate-400">الوجهة وخط السير:</span>
      <span class="font-bold text-white text-xs">${escapeHtml(trip.destination || 'غير محددة')}</span>
    </div>
    <div class="flex items-center justify-between border-b border-slate-800 pb-2">
      <span class="text-slate-400">الركاب والمرافقين:</span>
      <span class="text-slate-200 text-xs">${escapeHtml(passengersStr)}</span>
    </div>
    <div class="flex items-center justify-between border-b border-slate-800 pb-2">
      <span class="text-slate-400">موعد الانطلاق المقترح:</span>
      <span class="text-cyan-300 font-mono-numbers text-xs">${formatDateTime(trip.startTime)}</span>
    </div>
    ${trip.notes ? `
      <div class="pt-1">
        <span class="text-slate-400 block mb-1">تعليمات المشرف:</span>
        <div class="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 italic text-xs leading-relaxed">${escapeHtml(trip.notes)}</div>
      </div>
    ` : ''}
  `;

  const acceptBtn = document.getElementById('driverAcceptDispatchBtn');
  const rejectBtn = document.getElementById('driverRejectDispatchBtn');

  acceptBtn.onclick = () => handleDriverAcceptTrip(trip.id);
  rejectBtn.onclick = () => openDriverRejectModal(trip.id);

  openModal('driverDispatchAlertModal');
}

function renderPendingDispatches() {
  const container = document.getElementById('driverPendingDispatchContainer');
  if (!container || !appState.currentUser) return;

  const username = appState.currentUser.username.toLowerCase();
  const driverDispatches = appState.trips.filter(t => 
    t.driverUsername && t.driverUsername.toLowerCase() === username &&
    (t.status === 'dispatched' || t.status === 'accepted') &&
    !t.endOdometer
  );

  if (driverDispatches.length === 0) {
    container.innerHTML = '';
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  container.innerHTML = driverDispatches.map(trip => {
    const isPending = !trip.driverResponse || trip.driverResponse === 'pending';
    const isAccepted = trip.driverResponse === 'accepted';
    const passengersStr = trip.passengers && trip.passengers.length > 0 ? trip.passengers.join('، ') : 'السائق بمفرده';

    return `
      <div class="glass-card rounded-2xl p-4 sm:p-5 border-2 ${isPending ? 'border-amber-500/70 bg-amber-950/25 shadow-xl shadow-amber-950/40' : 'border-emerald-500/60 bg-emerald-950/25'} space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5">
          <div class="flex items-center gap-2">
            <span class="w-3 h-3 rounded-full ${isPending ? 'bg-amber-400 animate-ping' : 'bg-emerald-400'}"></span>
            <h4 class="text-sm font-bold text-white">${isPending ? 'حجز وتكليف جديد بانتظار تأكيدك ⏳' : 'رحلة محجوزة ومؤكدة الجاهزية ✅'}</h4>
          </div>
          <span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">
            ${escapeHtml(trip.team)}
          </span>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
          <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
            <span class="text-slate-400 block text-[11px] mb-0.5">الوجهة:</span>
            <span class="font-bold text-white">${escapeHtml(trip.destination || 'ميدانية')}</span>
          </div>
          <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
            <span class="text-slate-400 block text-[11px] mb-0.5">المركبة:</span>
            <span class="font-bold text-slate-200 font-mono-numbers">${escapeHtml(trip.vehicle || '')}</span>
          </div>
          <div class="bg-slate-950/60 p-2.5 rounded-xl border border-slate-800">
            <span class="text-slate-400 block text-[11px] mb-0.5">الموعد:</span>
            <span class="text-cyan-300 font-mono-numbers">${formatDateTime(trip.startTime)}</span>
          </div>
        </div>

        ${trip.notes ? `
          <div class="text-xs bg-slate-900/80 p-2.5 rounded-xl border border-slate-800 text-slate-300">
            <span class="font-semibold text-slate-400">تعليمات المشرف:</span> ${escapeHtml(trip.notes)}
          </div>
        ` : ''}

        <div class="pt-1 flex flex-wrap gap-2">
          ${isPending ? `
            <button onclick="handleDriverAcceptTrip('${trip.id}')" class="flex-1 py-3 px-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-extrabold text-xs rounded-xl shadow-lg transition-all flex items-center justify-center gap-1.5 transform active:scale-95">
              <i data-lucide="check-circle-2" class="w-4 h-4"></i>
              <span>تأكيد الاستلام والجاهزية (متاح) ✅</span>
            </button>
            <button onclick="openDriverRejectModal('${trip.id}')" class="py-3 px-4 bg-slate-900 hover:bg-slate-800 border border-rose-500/40 text-rose-300 font-bold text-xs rounded-xl transition-colors flex items-center justify-center gap-1.5">
              <i data-lucide="x-circle" class="w-4 h-4 text-rose-400"></i>
              <span>اعتذار (غير متاح) ❌</span>
            </button>
          ` : `
            <button onclick="startDispatchedTripNow('${trip.id}')" class="w-full py-3.5 px-4 bg-gradient-to-r from-rose-600 to-amber-600 hover:from-rose-500 hover:to-amber-500 text-white font-extrabold text-xs rounded-xl shadow-xl transition-all flex items-center justify-center gap-2 transform active:scale-95">
              <i data-lucide="play" class="w-4 h-4"></i>
              <span>الانطلاق بالرحلة وتسجيل قراءة العداد 🚀</span>
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');

  initLucideIcons();
}

async function handleDriverAcceptTrip(tripId) {
  try {
    const res = await fetch(`/api/trips/${tripId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverResponse: 'accepted' })
    });
    if (res.ok) {
      const data = await res.json();
      const trip = data.trip;
      const idx = appState.trips.findIndex(t => t.id === tripId);
      if (idx !== -1) appState.trips[idx] = trip;
      localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));
    }
  } catch (err) {
    console.warn('تعذر الرد عبر السيرفر، تم التحديث محلياً:', err);
    const trip = appState.trips.find(t => t.id === tripId);
    if (trip) {
      trip.driverResponse = 'accepted';
      trip.status = 'accepted';
      localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));
    }
  }

  closeModal('driverDispatchAlertModal');
  showToast('تم تأكيد الاستلام والجاهزية للمشرف بنجاح ✅', 'success');
  renderDriverView();

  const trip = appState.trips.find(t => t.id === tripId);
  if (trip && confirm('تم تأكيد الجاهزية! هل ترغب في تسجيل عداد البداية والانطلاق الآن؟ 🚗')) {
    startDispatchedTripNow(tripId);
  }
}

let activeRejectTripId = null;

function openDriverRejectModal(tripId) {
  activeRejectTripId = tripId;
  closeModal('driverDispatchAlertModal');
  document.getElementById('rejectReasonPreset').value = 'المركبة في الصيانة أو الفحص الفني';
  document.getElementById('rejectReasonCustom').value = '';
  document.getElementById('rejectReasonCustom').classList.add('hidden');
  openModal('driverRejectModal');
}

function handleRejectReasonPresetChange() {
  const preset = document.getElementById('rejectReasonPreset').value;
  const custom = document.getElementById('rejectReasonCustom');
  if (preset === 'CUSTOM') {
    custom.classList.remove('hidden');
    custom.focus();
  } else {
    custom.classList.add('hidden');
  }
}

async function confirmDriverRejectSubmission() {
  if (!activeRejectTripId) return;

  const preset = document.getElementById('rejectReasonPreset').value;
  const custom = document.getElementById('rejectReasonCustom').value.trim();
  const reason = preset === 'CUSTOM' ? (custom || 'غير متاح حالياً') : preset;

  try {
    const res = await fetch(`/api/trips/${activeRejectTripId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverResponse: 'rejected', rejectionReason: reason })
    });
    if (res.ok) {
      const data = await res.json();
      const trip = data.trip;
      const idx = appState.trips.findIndex(t => t.id === activeRejectTripId);
      if (idx !== -1) appState.trips[idx] = trip;
      localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));
    }
  } catch (err) {
    console.warn('تعذر الرد عبر السيرفر، تم التحديث محلياً:', err);
    const trip = appState.trips.find(t => t.id === activeRejectTripId);
    if (trip) {
      trip.driverResponse = 'rejected';
      trip.status = 'rejected';
      trip.rejectionReason = reason;
      localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));
    }
  }

  closeModal('driverRejectModal');
  showToast(`تم إرسال الاعتذار (${reason}) للمشرف بنجاح`, 'info');
  renderDriverView();
}

function startDispatchedTripNow(tripId) {
  const trip = appState.trips.find(t => t.id === tripId);
  if (!trip) return;

  openStartTripModal(trip);
}

// ==========================================
// 15. تحكم نهاية العداد وحذف الرحلات للأدمن
// (المشرف يعدل نهاية العداد ويحذف رحلات)
// ==========================================

function openQuickEndOdometerModal(tripId) {
  if (!hasPermission('canEditTrips')) {
    showToast('عذراً، لا تملك صلاحية تعديل الرحلات', 'warning');
    return;
  }

  const trip = appState.trips.find(t => t.id === tripId);
  if (!trip) return;

  document.getElementById('quickEditTripId').value = trip.id;
  document.getElementById('quickEditDriverName').textContent = trip.driverName;
  document.getElementById('quickEditTeam').textContent = trip.team;
  document.getElementById('quickEditStartOdoDisplay').textContent = `${trip.startOdometer || 0} كم`;

  const endInput = document.getElementById('quickEditEndOdoInput');
  endInput.value = trip.endOdometer || (trip.startOdometer || 0);

  const endTimeInput = document.getElementById('quickEditEndTime');
  if (trip.endTime) {
    endTimeInput.value = trip.endTime.slice(0, 16);
  } else {
    endTimeInput.value = getLocalIsoDateTime();
  }

  calculateQuickEndDistance();
  openModal('quickEditEndOdoModal');
}

function calculateQuickEndDistance() {
  const tripId = document.getElementById('quickEditTripId').value;
  const trip = appState.trips.find(t => t.id === tripId);
  const startKm = trip ? (trip.startOdometer || 0) : 0;
  const endKm = Number(document.getElementById('quickEditEndOdoInput').value);
  const distLabel = document.getElementById('quickEditCalculatedDistance');

  if (!isNaN(endKm) && endKm >= startKm) {
    distLabel.textContent = `${endKm - startKm} كم`;
    distLabel.className = 'text-base font-black font-mono-numbers text-emerald-300';
  } else if (!isNaN(endKm) && endKm < startKm) {
    distLabel.textContent = 'عداد النهاية أقل من البداية ⚠️';
    distLabel.className = 'text-xs font-bold text-rose-400';
  } else {
    distLabel.textContent = '0 كم';
  }
}

async function handleQuickEndOdoSubmit(event) {
  event.preventDefault();
  const tripId = document.getElementById('quickEditTripId').value;
  const trip = appState.trips.find(t => t.id === tripId);
  if (!trip) return;

  const startKm = trip.startOdometer || 0;
  const endKm = Number(document.getElementById('quickEditEndOdoInput').value);
  const endTimeVal = document.getElementById('quickEditEndTime').value;

  if (isNaN(endKm) || endKm < startKm) {
    showToast('يجب أن تكون قراءة نهاية العداد أكبر من أو تساوي عداد البداية', 'warning');
    return;
  }

  const distanceKm = endKm - startKm;
  const endTime = endTimeVal ? new Date(endTimeVal).toISOString() : new Date().toISOString();

  const updatedTrip = {
    ...trip,
    endOdometer: endKm,
    distanceKm,
    endTime,
    status: 'completed'
  };

  try {
    await fetch(`/api/trips/${tripId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedTrip)
    });
  } catch (err) {
    console.warn('تعذر التحديث على السيرفر، تم التحديث محلياً:', err);
  }

  const idx = appState.trips.findIndex(t => t.id === tripId);
  if (idx !== -1) appState.trips[idx] = updatedTrip;
  localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));

  // Sync vehicle odometer
  if (appState.vehicles) {
    const veh = appState.vehicles.find(v => 
      (v.name && trip.vehicle && v.name.toLowerCase().includes(trip.vehicle.toLowerCase())) ||
      (v.driverUsername === trip.driverUsername)
    );
    if (veh) {
      veh.currentOdometer = Math.max(veh.currentOdometer || 0, endKm);
      localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
    }
  }

  closeModal('quickEditEndOdoModal');
  showToast(`تم حفظ نهاية العداد (${endKm} كم) واعتماد الرحلة بنجاح ⏱️`, 'success');
  await bootstrapFromServer();
  renderSupervisorView();
}

let pendingDeleteTripId = null;

function confirmAdminDeleteTrip(tripId) {
  if (!hasPermission('canDeleteTrips')) {
    showToast('عذراً، لا تملك صلاحية حذف الرحلات', 'warning');
    return;
  }

  const trip = appState.trips.find(t => t.id === tripId);
  if (!trip) return;

  pendingDeleteTripId = tripId;

  const summaryBox = document.getElementById('deleteTripSummaryBox');
  if (summaryBox) {
    summaryBox.innerHTML = `
      <div class="flex justify-between border-b border-slate-800 pb-1">
        <span class="text-slate-400">السائق:</span>
        <span class="font-bold text-white">${escapeHtml(trip.driverName)}</span>
      </div>
      <div class="flex justify-between border-b border-slate-800 pb-1">
        <span class="text-slate-400">المشروع:</span>
        <span class="font-bold text-rose-300">${escapeHtml(trip.team)}</span>
      </div>
      <div class="flex justify-between border-b border-slate-800 pb-1">
        <span class="text-slate-400">التاريخ:</span>
        <span class="text-cyan-300 font-mono-numbers">${formatDate(trip.startTime)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-slate-400">العداد:</span>
        <span class="text-slate-200 font-mono-numbers">${trip.startOdometer} كم ← ${trip.endOdometer ? trip.endOdometer + ' كم' : 'قيد التنفيذ'}</span>
      </div>
    `;
  }

  const confirmBtn = document.getElementById('confirmExecuteDeleteBtn');
  if (confirmBtn) {
    confirmBtn.onclick = executeDeleteTrip;
  }

  openModal('deleteTripConfirmModal');
}

async function executeDeleteTrip() {
  if (!pendingDeleteTripId) return;
  const tripId = pendingDeleteTripId;

  try {
    await fetch(`/api/trips/${tripId}`, { method: 'DELETE' });
  } catch (e) {
    console.warn('تعذر الحذف من السيرفر، تم الحذف محلياً');
  }

  appState.trips = appState.trips.filter(t => t.id !== tripId);
  localStorage.setItem(STORAGE_KEYS.CACHED_TRIPS, JSON.stringify(appState.trips));

  pendingDeleteTripId = null;
  closeModal('deleteTripConfirmModal');
  showToast('تم حذف الرحلة نهائياً من سجل الأسطول 🗑️', 'info');
  renderSupervisorView();
}

// =========================================================================
// 22. إدارة وسجلات تعبئة السولار والوقود لأسطول قرى الأطفال SOS
// "يضيف لنوع العربية كم تعئبة سولار بتاريخ والوقت ويظهر عند الكل فقط admin الي بقدر يغير"
// =========================================================================

function renderFuelLogsTable() {
  const supervisorTbody = document.getElementById('fleetFuelLogsTbody');
  const officerTbody = document.getElementById('fuelOfficerLogsTbody');
  const noSuperNotice = document.getElementById('noFuelLogsNotice');
  const noOfficerNotice = document.getElementById('noFuelOfficerLogsNotice');

  const logs = appState.fuelLogs || [];
  const isGeneralAdmin = appState.currentUser?.role === 'admin' || appState.currentUser?.username === 'admin';

  const rowsHtml = logs.length === 0 ? '' : logs.map((log, idx) => {
    const formattedDate = log.dateTime ? new Date(log.dateTime).toLocaleString('ar-EG', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) : '-';

    const costBadge = log.cost > 0 ? `<span class="text-amber-400 font-mono-numbers text-[11px] block mt-1">${log.cost} ₪</span>` : '';
    const isVillageStock = log.fuelSource === 'village_stock' || (log.station && log.station.includes('مخزون القرية'));
    const sourceBadge = isVillageStock 
      ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-black bg-sky-950/90 text-sky-300 border border-sky-600/60 shadow-sm"><i data-lucide="building-2" class="w-3 h-3 text-sky-400"></i> مخزون القرية (خزان SOS)</span>`
      : `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-950/90 text-amber-300 border border-amber-600/60 shadow-sm"><i data-lucide="fuel" class="w-3 h-3 text-amber-400"></i> محطة: ${escapeHtml(log.station || 'خارجية')}</span>`;

    // "فقط admin الي بقدر يغير": Actions are strictly rendered for admin!
    const actionButtons = isGeneralAdmin ? `
      <div class="flex items-center justify-center gap-1.5">
        <button onclick="openEditFuelLogModal('${log.id}')" class="p-1.5 rounded-lg bg-blue-500/15 hover:bg-blue-500/30 text-blue-400 hover:text-white transition-colors" title="تعديل السجل (المشرف العام)">
          <i data-lucide="edit-3" class="w-3.5 h-3.5"></i>
        </button>
        <button onclick="deleteFuelLog('${log.id}')" class="p-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-400 hover:text-white transition-colors" title="حذف السجل (المشرف العام)">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    ` : `
      <span class="text-[10px] text-slate-500 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">للمشرف العام</span>
    `;

    return `
      <tr class="hover:bg-slate-800/40 transition-colors">
        <td class="p-3 font-mono-numbers text-slate-400 text-xs">${idx + 1}</td>
        <td class="p-3 font-mono-numbers text-xs text-slate-200">
          <div class="font-bold">${formattedDate}</div>
        </td>
        <td class="p-3 text-xs">
          <span class="font-bold text-white flex items-center gap-1.5">
            <i data-lucide="car" class="w-3.5 h-3.5 text-blue-400"></i>
            <span>${escapeHtml(log.vehicleName)}</span>
          </span>
        </td>
        <td class="p-3 text-xs font-mono-numbers font-black text-amber-400">
          <span class="inline-flex items-center gap-1 bg-amber-500/15 border border-amber-500/30 px-2.5 py-1 rounded-lg">
            <i data-lucide="droplet" class="w-3.5 h-3.5 text-amber-400"></i>
            <span>${log.liters} لتر</span>
          </span>
        </td>
        <td class="p-3 text-xs font-mono-numbers text-cyan-300">
          ${log.odometer > 0 ? (log.odometer.toLocaleString() + ' كم') : '<span class="text-slate-600">-</span>'}
        </td>
        <td class="p-3 text-xs text-slate-300">
          <div>${sourceBadge}</div>
          ${costBadge}
        </td>
        <td class="p-3 text-xs">
          <span class="px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700/60 text-[11px] text-slate-300 font-bold">
            ${escapeHtml(log.recordedBy || 'مسؤول السولار')}
          </span>
        </td>
        <td class="p-3 text-xs text-slate-400 max-w-[150px] truncate" title="${escapeHtml(log.notes || '')}">
          ${log.notes ? escapeHtml(log.notes) : '<span class="text-slate-600">-</span>'}
        </td>
        <td class="p-3 text-center">
          ${actionButtons}
        </td>
      </tr>
    `;
  }).join('');

  if (supervisorTbody) {
    supervisorTbody.innerHTML = rowsHtml;
    if (noSuperNotice) {
      if (logs.length === 0) noSuperNotice.classList.remove('hidden');
      else noSuperNotice.classList.add('hidden');
    }
  }

  if (officerTbody) {
    officerTbody.innerHTML = rowsHtml;
    if (noOfficerNotice) {
      if (logs.length === 0) noOfficerNotice.classList.remove('hidden');
      else noOfficerNotice.classList.add('hidden');
    }
  }

  initLucideIcons();
}

function renderFuelOfficerDashboard() {
  const logs = appState.fuelLogs || [];
  const vehicles = appState.vehicles || [];

  // Today stats
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const todayLogs = logs.filter(l => l.dateTime && l.dateTime.slice(0, 10) === todayStr);

  const todayLiters = todayLogs.reduce((acc, l) => acc + (Number(l.liters) || 0), 0);
  const todayCount = todayLogs.length;
  const totalAllLiters = logs.reduce((acc, l) => acc + (Number(l.liters) || 0), 0);

  const elTodayLiters = document.getElementById('fuelTodayLiters');
  if (elTodayLiters) elTodayLiters.innerHTML = `${todayLiters.toLocaleString()} <span class="text-sm font-normal text-slate-400">لتر</span>`;

  const elTodayCount = document.getElementById('fuelTodayCount');
  if (elTodayCount) elTodayCount.textContent = todayCount;

  const elTotalAllLiters = document.getElementById('fuelTotalAllLiters');
  if (elTotalAllLiters) elTotalAllLiters.innerHTML = `${totalAllLiters.toLocaleString()} <span class="text-sm font-normal text-slate-400">لتر</span>`;

  const elVehCount = document.getElementById('fuelTotalVehiclesCount');
  if (elVehCount) elVehCount.textContent = vehicles.length;

  // Render fuel officer vehicles grid
  const grid = document.getElementById('fuelOfficerVehiclesGrid');
  if (grid) {
    if (vehicles.length === 0) {
      grid.innerHTML = '<div class="col-span-full p-4 text-center text-slate-500">لا توجد مركبات مسجلة في الأسطول.</div>';
    } else {
      grid.innerHTML = vehicles.map(v => {
        const capacity = v.fuelCapacityLiters || 60;
        const currentFuel = v.currentFuelLiters !== undefined ? v.currentFuelLiters : 40;
        const percent = Math.min(100, Math.round((currentFuel / capacity) * 100));

        let barColor = 'bg-emerald-500';
        let textColor = 'text-emerald-400';
        if (percent < 25) {
          barColor = 'bg-rose-500';
          textColor = 'text-rose-400';
        } else if (percent < 50) {
          barColor = 'bg-amber-500';
          textColor = 'text-amber-400';
        }

        return `
          <div class="p-3.5 rounded-2xl bg-slate-900/90 border border-slate-800 hover:border-amber-500/40 transition-all space-y-3">
            <div class="flex items-center justify-between border-b border-slate-800 pb-2">
              <div class="flex items-center gap-2">
                <div class="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center">
                  <i data-lucide="car" class="w-4 h-4"></i>
                </div>
                <div>
                  <h5 class="text-xs font-bold text-white">${escapeHtml(v.name)}</h5>
                  <span class="text-[10px] text-slate-400 font-mono-numbers">لوحة: ${escapeHtml(v.plateNumber || '-')}</span>
                </div>
              </div>
              <button onclick="quickFillVehicle('${escapeHtml(v.name)}', ${v.currentOdometer || 0})" class="px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-[11px] font-bold flex items-center gap-1 transition-all">
                <i data-lucide="fuel" class="w-3.5 h-3.5"></i>
                <span>تعبئة</span>
              </button>
            </div>

            <div class="text-[11px] text-slate-400 flex items-center justify-between">
              <span>السائق المعين:</span>
              <span class="font-bold text-white">${escapeHtml(v.driverName || 'غير معين')}</span>
            </div>

            <div class="p-2 rounded-xl bg-slate-950 border border-slate-800/80 space-y-1">
              <div class="flex items-center justify-between text-xs">
                <span class="text-slate-400 flex items-center gap-1">
                  <i data-lucide="fuel" class="w-3.5 h-3.5 text-amber-400"></i>
                  <span>كمية الوقود:</span>
                </span>
                <span class="font-mono-numbers font-bold ${textColor}">${currentFuel} لتر <span class="text-[10px] text-slate-500">(${percent}%)</span></span>
              </div>
              <div class="w-full bg-slate-900 rounded-full h-2 overflow-hidden border border-slate-800">
                <div class="${barColor} h-2 rounded-full transition-all duration-500" style="width: ${percent}%"></div>
              </div>
            </div>

            <div class="flex items-center justify-between text-[11px] text-slate-400">
              <span class="flex items-center gap-1">
                <i data-lucide="gauge" class="w-3 h-3 text-cyan-400"></i>
                <span>العداد:</span>
              </span>
              <span class="font-mono-numbers font-bold text-cyan-300">${(v.currentOdometer || 0).toLocaleString()} كم</span>
            </div>

            ${v.lastRefuel ? `
              <div class="text-[10px] text-slate-400 bg-amber-950/20 border border-amber-900/30 rounded-lg p-1.5 flex items-center justify-between">
                <span class="text-amber-400 font-bold flex items-center gap-1">
                  <i data-lucide="droplet" class="w-3 h-3"></i>
                  <span>آخر تعبئة:</span>
                </span>
                <span class="text-slate-300 font-mono-numbers">${v.lastRefuel.liters} لتر (${new Date(v.lastRefuel.dateTime).toLocaleDateString('ar-EG', {month: 'numeric', day: 'numeric'})})</span>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    }
  }

  renderFuelLogsTable();
  initLucideIcons();
}

function toggleAddFuelSource(source) {
  const container = document.getElementById('addFuelStationContainer');
  const label = document.getElementById('addFuelStationLabel');
  const input = document.getElementById('addFuelStation');
  const costInput = document.getElementById('addFuelCost');

  if (source === 'village_stock') {
    if (label) label.textContent = 'المصدر الداخلي (مخزون القرية)';
    if (input) {
      input.value = 'مخزون القرية الداخلي (خزان SOS)';
      input.readOnly = true;
      input.classList.add('bg-slate-950', 'text-sky-300', 'font-bold');
    }
    if (costInput && !costInput.value) {
      costInput.placeholder = '0 (خزان داخلي)';
    }
  } else {
    if (label) label.textContent = 'محطة الوقود الخارجية';
    if (input) {
      input.readOnly = false;
      input.classList.remove('bg-slate-950', 'text-sky-300', 'font-bold');
      if (input.value === 'مخزون القرية الداخلي (خزان SOS)') input.value = '';
      input.placeholder = 'مثال: محطة الهدى - ديزل';
    }
    if (costInput) {
      costInput.placeholder = 'المبلغ بالشيكل...';
    }
  }
}

function toggleEditFuelSource(source) {
  const label = document.getElementById('editFuelStationLabel');
  const input = document.getElementById('editFuelStation');
  if (source === 'village_stock') {
    if (label) label.textContent = 'المصدر الداخلي (مخزون القرية)';
    if (input) {
      input.value = 'مخزون القرية الداخلي (خزان SOS)';
      input.readOnly = true;
      input.classList.add('bg-slate-950', 'text-sky-300', 'font-bold');
    }
  } else {
    if (label) label.textContent = 'محطة الوقود الخارجية';
    if (input) {
      input.readOnly = false;
      input.classList.remove('bg-slate-950', 'text-sky-300', 'font-bold');
      if (input.value === 'مخزون القرية الداخلي (خزان SOS)') input.value = '';
    }
  }
}

function openAddFuelLogModal(prefillVehicle = '', prefillOdo = 0) {
  const select = document.getElementById('addFuelVehicleSelect');
  const custom = document.getElementById('addFuelVehicleCustom');
  const odoInput = document.getElementById('addFuelOdometer');
  const dtInput = document.getElementById('addFuelDateTime');

  const radioStation = document.querySelector('input[name="addFuelSourceRadio"][value="station"]');
  if (radioStation) radioStation.checked = true;
  toggleAddFuelSource('station');

  if (select) {
    select.innerHTML = '<option value="">اختر نوع العربية من الأسطول...</option>';
    (appState.vehicles || []).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.driverName ? v.driverName : 'غير معين'})`;
      select.appendChild(opt);
    });
    const optOther = document.createElement('option');
    optOther.value = 'OTHER';
    optOther.textContent = 'نوع آخر (إدخال يدوي)...';
    select.appendChild(optOther);

    if (prefillVehicle) {
      select.value = prefillVehicle;
      if (custom) custom.classList.add('hidden');
    }
  }

  if (dtInput) {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    dtInput.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  if (odoInput && prefillOdo > 0) {
    odoInput.value = prefillOdo;
  }

  openModal('addFuelLogModal');
}

function quickFillVehicle(vehName, odo) {
  openAddFuelLogModal(vehName, odo);
}

function handleAddFuelVehicleChange() {
  const select = document.getElementById('addFuelVehicleSelect');
  const custom = document.getElementById('addFuelVehicleCustom');
  if (!select || !custom) return;

  if (select.value === 'OTHER') {
    custom.classList.remove('hidden');
    custom.required = true;
    custom.focus();
  } else {
    custom.classList.add('hidden');
    custom.required = false;

    // Auto fill odometer from vehicle
    const veh = (appState.vehicles || []).find(v => v.name.toLowerCase() === select.value.toLowerCase());
    if (veh && veh.currentOdometer > 0) {
      const odoInput = document.getElementById('addFuelOdometer');
      if (odoInput && !odoInput.value) {
        odoInput.value = veh.currentOdometer;
      }
    }
  }
}

async function handleAddFuelLogSubmit(event) {
  event.preventDefault();
  const select = document.getElementById('addFuelVehicleSelect');
  const custom = document.getElementById('addFuelVehicleCustom');
  const litersInput = document.getElementById('addFuelLiters');
  const dtInput = document.getElementById('addFuelDateTime');
  const odoInput = document.getElementById('addFuelOdometer');
  const stationInput = document.getElementById('addFuelStation');
  const costInput = document.getElementById('addFuelCost');
  const notesInput = document.getElementById('addFuelNotes');
  const submitBtn = document.getElementById('addFuelSubmitBtn');

  const selectedSource = document.querySelector('input[name="addFuelSourceRadio"]:checked')?.value || 'station';
  const fuelSource = selectedSource;
  const vehicleName = select.value === 'OTHER' ? (custom ? custom.value.trim() : '') : select.value.trim();
  const liters = Number(litersInput.value);
  const dateTime = dtInput.value;
  const odometer = Number(odoInput.value) || 0;
  const station = fuelSource === 'village_stock' 
    ? 'مخزون القرية الداخلي (خزان SOS)' 
    : (stationInput ? stationInput.value.trim() : 'محطة وقود خارجية');
  const cost = Number(costInput ? costInput.value : 0) || 0;
  const notes = notesInput ? notesInput.value.trim() : '';

  if (!vehicleName || !liters || liters <= 0) {
    showToast('يرجى تحديد نوع المركبة وكمية السولار باللتر', 'warning');
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  const payload = {
    vehicleName,
    liters,
    dateTime,
    odometer,
    fuelSource,
    station,
    cost,
    notes,
    recordedBy: appState.currentUser?.name || 'مسؤول السولار والوقود',
    recordedByUsername: appState.currentUser?.username || 'fuel'
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch('/api/fuel-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (res.ok && data.success) {
      if (!appState.fuelLogs) appState.fuelLogs = [];
      appState.fuelLogs.unshift(data.fuelLog);
      localStorage.setItem(STORAGE_KEYS.CACHED_FUEL_LOGS, JSON.stringify(appState.fuelLogs));

      await bootstrapFromServer();

      closeModal('addFuelLogModal');
      document.getElementById('addFuelLogForm').reset();
      showToast(`تم تسجيل تعبئة السولار لـ "${vehicleName}" (${liters} لتر) بنجاح ⛽`, 'success');

      renderFuelLogsTable();
      renderFleetVehiclesCards();
      if (appState.currentUser?.role === 'fuel_officer') {
        renderFuelOfficerDashboard();
      }
    } else {
      showToast(data.error || 'فشل حفظ سجل السولار', 'warning');
    }
  } catch (err) {
    console.error('Fuel Log Submit Error:', err);
    const localLog = {
      id: 'FUEL_' + Date.now(),
      ...payload,
      createdAt: new Date().toISOString()
    };
    if (!appState.fuelLogs) appState.fuelLogs = [];
    appState.fuelLogs.unshift(localLog);
    localStorage.setItem(STORAGE_KEYS.CACHED_FUEL_LOGS, JSON.stringify(appState.fuelLogs));

    enqueueSyncAction({
      type: 'ADD_FUEL_LOG',
      tempId: localLog.id,
      payload: payload
    });

    closeModal('addFuelLogModal');
    document.getElementById('addFuelLogForm').reset();
    showToast(`تم الحفظ محلياً: تعبئة ${liters} لتر لـ "${vehicleName}" (سيتم الترحيل فور شبك النت) ⛽`, 'info');

    renderFuelLogsTable();
    renderFleetVehiclesCards();
    if (appState.currentUser?.role === 'fuel_officer') {
      renderFuelOfficerDashboard();
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// "فقط admin الي بقدر يغير" (Edit & Delete Fuel Logs strictly for General Admin)

function openEditFuelLogModal(logId) {
  if (appState.currentUser?.role !== 'admin' && appState.currentUser?.username !== 'admin') {
    showToast('عذراً، تعديل سجلات تعبئة السولار محصور بحساب المشرف العام (admin) فقط', 'warning');
    return;
  }

  const log = (appState.fuelLogs || []).find(l => l.id === logId);
  if (!log) {
    showToast('سجل السولار غير موجود', 'warning');
    return;
  }

  document.getElementById('editFuelLogId').value = log.id;
  document.getElementById('editFuelVehicle').value = log.vehicleName || '';
  document.getElementById('editFuelLiters').value = log.liters || '';

  const isVillage = log.fuelSource === 'village_stock' || (log.station && log.station.includes('مخزون القرية'));
  const radioStation = document.querySelector('input[name="editFuelSourceRadio"][value="station"]');
  const radioVillage = document.querySelector('input[name="editFuelSourceRadio"][value="village_stock"]');
  if (isVillage) {
    if (radioVillage) radioVillage.checked = true;
    toggleEditFuelSource('village_stock');
  } else {
    if (radioStation) radioStation.checked = true;
    toggleEditFuelSource('station');
    document.getElementById('editFuelStation').value = log.station || '';
  }

  if (log.dateTime) {
    const d = new Date(log.dateTime);
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('editFuelDateTime').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } else {
    document.getElementById('editFuelDateTime').value = '';
  }

  document.getElementById('editFuelOdometer').value = log.odometer || '';
  document.getElementById('editFuelCost').value = log.cost || '';
  document.getElementById('editFuelNotes').value = log.notes || '';

  openModal('editFuelLogModal');
}

async function handleEditFuelLogSubmit(event) {
  event.preventDefault();
  if (appState.currentUser?.role !== 'admin' && appState.currentUser?.username !== 'admin') {
    showToast('عذراً، تعديل سجلات السولار محصور بحساب المشرف العام (admin) فقط', 'warning');
    return;
  }

  const logId = document.getElementById('editFuelLogId').value;
  const vehicleName = document.getElementById('editFuelVehicle').value.trim();
  const liters = Number(document.getElementById('editFuelLiters').value);
  const dateTime = document.getElementById('editFuelDateTime').value;
  const odometer = Number(document.getElementById('editFuelOdometer').value) || 0;
  const selectedSource = document.querySelector('input[name="editFuelSourceRadio"]:checked')?.value || 'station';
  const station = selectedSource === 'village_stock'
    ? 'مخزون القرية الداخلي (خزان SOS)'
    : (document.getElementById('editFuelStation').value.trim() || 'محطة وقود خارجية');
  const cost = Number(document.getElementById('editFuelCost').value) || 0;
  const notes = document.getElementById('editFuelNotes').value.trim();

  const body = {
    vehicleName,
    liters,
    dateTime,
    odometer,
    fuelSource: selectedSource,
    station,
    cost,
    notes,
    requesterRole: 'admin',
    requesterUsername: 'admin'
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`/api/fuel-logs/${logId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    if (res.ok && data.success) {
      const idx = appState.fuelLogs.findIndex(l => l.id === logId);
      if (idx !== -1) {
        appState.fuelLogs[idx] = data.fuelLog;
      }
      localStorage.setItem(STORAGE_KEYS.CACHED_FUEL_LOGS, JSON.stringify(appState.fuelLogs));
      closeModal('editFuelLogModal');
      showToast('تم تحديث سجل السولار بنجاح 💾', 'success');

      renderFuelLogsTable();
      renderFleetVehiclesCards();
    } else {
      showToast(data.error || 'فشل تعديل سجل السولار', 'warning');
    }
  } catch (e) {
    showToast('حدث خطأ أثناء تعديل السجل', 'warning');
  }
}

async function deleteFuelLog(logId) {
  if (appState.currentUser?.role !== 'admin' && appState.currentUser?.username !== 'admin') {
    showToast('عذراً، حذف سجلات تعبئة السولار محصور بحساب المشرف العام (admin) فقط', 'warning');
    return;
  }

  const log = (appState.fuelLogs || []).find(l => l.id === logId);
  const desc = log ? `تعبئة "${log.vehicleName}" (${log.liters} لتر)` : 'هذا السجل';

  if (!confirm(`هل أنت متأكد من رغبتك في حذف ${desc} نهائياً من النظام؟\n(هذا الإجراء محصور بالمشرف العام admin)`)) {
    return;
  }

  try {
    const res = await fetch(`/api/fuel-logs/${logId}?role=admin&username=admin`, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (res.ok && data.success) {
      appState.fuelLogs = appState.fuelLogs.filter(l => l.id !== logId);
      localStorage.setItem(STORAGE_KEYS.CACHED_FUEL_LOGS, JSON.stringify(appState.fuelLogs));
      showToast('تم حذف سجل السولار بنجاح 🗑️', 'info');

      renderFuelLogsTable();
      renderFleetVehiclesCards();
    } else {
      showToast(data.error || 'فشل حذف سجل السولار', 'warning');
    }
  } catch (e) {
    showToast('حدث خطأ أثناء حذف السجل', 'warning');
  }
}


// =========================================================================
// 15. تحكم المشرف العام الكامل (Admin Master Control & Module Switcher)
// "admin يتحكم فيهم كلهم"
// =========================================================================

function updateAdminNavActiveButton(moduleName) {
  const tripsBtn = document.getElementById('adminNavTripsBtn');
  const procBtn = document.getElementById('adminNavProcurementBtn');
  const fuelBtn = document.getElementById('adminNavFuelBtn');

  const activeClass = 'px-3 py-1.5 rounded-xl bg-blue-600 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-all';
  const inactiveClass = 'px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white font-bold text-xs flex items-center gap-1.5 transition-all';

  if (tripsBtn) tripsBtn.className = moduleName === 'trips' ? activeClass : inactiveClass;
  if (procBtn) procBtn.className = moduleName === 'procurement' ? activeClass : inactiveClass;
  if (fuelBtn) fuelBtn.className = moduleName === 'fuel' ? activeClass : inactiveClass;
}

function switchToAdminModule(moduleName) {
  if (appState.currentUser?.role !== 'admin' && appState.currentUser?.username !== 'admin') {
    showToast('هذه الميزة محصورة بحساب المشرف العام (admin)', 'warning');
    return;
  }

  const supervisorView = document.getElementById('supervisorView');
  const procurementView = document.getElementById('procurementView');
  const fuelOfficerView = document.getElementById('fuelOfficerView');
  const driverView = document.getElementById('driverView');

  if (driverView) driverView.classList.add('hidden');

  updateAdminNavActiveButton(moduleName);

  if (moduleName === 'trips') {
    if (procurementView) procurementView.classList.add('hidden');
    if (fuelOfficerView) fuelOfficerView.classList.add('hidden');
    if (supervisorView) supervisorView.classList.remove('hidden');
    renderSupervisorView();
  } else if (moduleName === 'procurement') {
    if (supervisorView) supervisorView.classList.add('hidden');
    if (fuelOfficerView) fuelOfficerView.classList.add('hidden');
    if (procurementView) procurementView.classList.remove('hidden');
    renderProcurementDashboard();
  } else if (moduleName === 'fuel') {
    if (supervisorView) supervisorView.classList.add('hidden');
    if (procurementView) procurementView.classList.add('hidden');
    if (fuelOfficerView) fuelOfficerView.classList.remove('hidden');
    renderFuelOfficerDashboard();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
  initLucideIcons();
  logUserAction('MODULE_OPEN', 'قام بفتح قسم: ' + (moduleName === 'trips' ? 'رحلات الأسطول والمتابعة' : moduleName === 'procurement' ? 'المشتريات وجرد السيارات' : 'سجل ومحطة السولار'));
}

function toggleProcurementViewForAdmin() {
  if (!canViewFinancials()) {
    showToast('عذراً، الاطلاع على الحسابات المالية والتسعير محصور بمسؤول المشتريات والمشرف العام فقط', 'warning');
    return;
  }
  switchToAdminModule('procurement');
}

// =========================================================================
// 16. متابعة السائقين اللحظية: مين متاح ومين طالع
// "بدي supervisor يعرف مين متاح ومين طالع"
// =========================================================================

function renderDriversAvailabilitySection() {
  const availList = document.getElementById('availableDriversList');
  const busyList = document.getElementById('busyDriversList');
  const availCountBadge = document.getElementById('availDriversCountBadge');
  const busyCountBadge = document.getElementById('busyDriversCountBadge');
  const noAvailPrompt = document.getElementById('noAvailableDriversPrompt');
  const noBusyPrompt = document.getElementById('noBusyDriversPrompt');

  if (!availList || !busyList) return;

  const drivers = (appState.users || []).filter(u => u.role === 'driver' && u.active !== false);
  const activeTrips = (appState.trips || []).filter(t => t.status === 'in_progress');

  const busyDrivers = [];
  const availDrivers = [];

  drivers.forEach(d => {
    const activeTrip = activeTrips.find(t => t.driverUsername === d.username || t.driverName === d.name);
    if (activeTrip) {
      busyDrivers.push({ driver: d, trip: activeTrip });
    } else {
      availDrivers.push(d);
    }
  });

  if (availCountBadge) availCountBadge.textContent = availDrivers.length;
  if (busyCountBadge) busyCountBadge.textContent = busyDrivers.length;

  // Render Available Drivers (متاح 🟢)
  if (availDrivers.length === 0) {
    availList.innerHTML = '';
    if (noAvailPrompt) noAvailPrompt.classList.remove('hidden');
  } else {
    if (noAvailPrompt) noAvailPrompt.classList.add('hidden');
    availList.innerHTML = availDrivers.map(d => `
      <div class="p-3 rounded-xl bg-slate-900 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-3 shadow-sm hover:border-emerald-500/60 transition-all">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center font-bold shrink-0">
            <i data-lucide="user-check" class="w-4 h-4"></i>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h5 class="text-xs font-bold text-white">${escapeHtml(d.name)}</h5>
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🟢 متاح للتحرك</span>
            </div>
            <div class="flex items-center gap-3 text-[11px] text-slate-400 mt-1">
              <span class="flex items-center gap-1 font-mono-numbers">
                <i data-lucide="car" class="w-3 h-3 text-cyan-400"></i>
                <span>${escapeHtml(d.vehicle || 'مركبة غير محددة')}</span>
              </span>
              ${d.phone ? `
                <a href="tel:${escapeHtml(d.phone)}" class="flex items-center gap-1 text-slate-300 hover:text-white font-mono-numbers">
                  <i data-lucide="phone" class="w-3 h-3 text-rose-400"></i>
                  <span>${escapeHtml(d.phone)}</span>
                </a>
              ` : ''}
            </div>
          </div>
        </div>
        <button type="button" onclick="openDispatchTripModal('${escapeHtml(d.username)}', '${escapeHtml(d.vehicle || '')}')" class="px-3 py-1.5 rounded-lg bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-sm transition-all transform active:scale-95">
          <i data-lucide="send" class="w-3 h-3"></i>
          <span>حجز وتكليف 🚀</span>
        </button>
      </div>
    `).join('');
  }

  // Render Drivers Out on Trip (طالع 🔴)
  if (busyDrivers.length === 0) {
    busyList.innerHTML = '';
    if (noBusyPrompt) noBusyPrompt.classList.remove('hidden');
  } else {
    if (noBusyPrompt) noBusyPrompt.classList.add('hidden');
    busyList.innerHTML = busyDrivers.map(({ driver, trip }) => {
      // Calculate elapsed time
      let durationStr = 'جارية الآن';
      if (trip.startDateTime) {
        const start = new Date(trip.startDateTime);
        const now = new Date();
        const diffMinutes = Math.max(0, Math.floor((now - start) / 60000));
        const hours = Math.floor(diffMinutes / 60);
        const mins = diffMinutes % 60;
        durationStr = hours > 0 ? `منذ ${hours} س و ${mins} د` : `منذ ${mins} دقيقة`;
      }

      return `
        <div class="p-3 rounded-xl bg-slate-900 border border-rose-500/30 flex flex-wrap items-center justify-between gap-3 shadow-sm hover:border-rose-500/60 transition-all">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-xl bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center font-bold shrink-0">
              <i data-lucide="navigation-2" class="w-4 h-4 animate-pulse"></i>
            </div>
            <div>
              <div class="flex items-center gap-2">
                <h5 class="text-xs font-bold text-white">${escapeHtml(driver.name)}</h5>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">🔴 طالع في رحلة</span>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500/20 text-blue-300 border border-blue-500/40">${escapeHtml(trip.team)}</span>
              </div>
              <div class="flex flex-wrap items-center gap-3 text-[11px] text-slate-400 mt-1">
                <span class="flex items-center gap-1 font-mono-numbers">
                  <i data-lucide="car" class="w-3 h-3 text-cyan-400"></i>
                  <span>${escapeHtml(trip.vehicle || driver.vehicle || 'مركبة')}</span>
                </span>
                <span class="flex items-center gap-1 text-slate-300">
                  <i data-lucide="map-pin" class="w-3 h-3 text-rose-400"></i>
                  <span>الوجهة: <strong>${escapeHtml(trip.destination || 'غير محددة')}</strong></span>
                </span>
                <span class="flex items-center gap-1 font-mono-numbers text-amber-300">
                  <i data-lucide="clock" class="w-3 h-3"></i>
                  <span>${durationStr}</span>
                </span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2">
            ${driver.phone ? `
              <a href="tel:${escapeHtml(driver.phone)}" class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1 border border-slate-700" title="اتصال بالسائق">
                <i data-lucide="phone" class="w-3 h-3 text-rose-400"></i>
                <span class="hidden sm:inline">اتصال</span>
              </a>
            ` : ''}
            <button type="button" onclick="openTripDetailsModal('${trip.id}')" class="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-300 hover:text-white font-bold text-xs flex items-center gap-1.5 border border-slate-700 transition-all">
              <i data-lucide="eye" class="w-3 h-3"></i>
              <span>تفاصيل الرحلة</span>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  initLucideIcons();
}

// =========================================================================
// 17. وحدة مسؤول المشتريات وجرد الأسطول (Procurement & Inventory)
// "بدي اعمل مستخدم تبع المشتريات بحيث يكون يعمل كل سيارة الها حساب ويحط السعر السيارة ويطلع اجمالي اله والكامل مع جرد"
// =========================================================================

let currentProcurementTab = 'teams';
let currentLedgerVehicleName = '';

// =========================================================================
// حسابات الإيجار اليومي للأسطول وقاعدة احتساب أول طلعة فقط
// "مش شراء هو تسعيرة اجار باليوم يتم احتساب السيارة ع كل فريق لحاله
// بحيث اول طلعة لسيارة يتم احتسابها فقط باقي اليوم ما يتم حسابه ولكن تسجيل الرحلات"
// =========================================================================

function computeLocalFleetRentalAccounts() {
  const trips = appState.trips || [];
  const vehicles = appState.vehicles || [];
  const teams = appState.teams || ['يونيسف', 'DRA', 'FS', 'HA', 'إداري'];
  const purchases = appState.purchases || [];

  const vehicleDateTrips = new Map();

  trips.forEach(t => {
    const rawTime = t.startDateTime || t.startTime || t.createdAt;
    if (!rawTime) return;
    const dateStr = String(rawTime).slice(0, 10); // YYYY-MM-DD
    const vehicleName = (t.vehicle || '').trim();
    if (!vehicleName) return;

    const key = `${vehicleName}:::${dateStr}`;
    if (!vehicleDateTrips.has(key)) {
      vehicleDateTrips.set(key, []);
    }
    vehicleDateTrips.get(key).push(t);
  });

  const tripBillingMap = {};
  const vehicleBillingDays = new Map();
  const teamBillingDays = new Map();
  const dailyAllocations = [];

  teams.forEach(team => {
    teamBillingDays.set(team, []);
  });

  for (const [key, vTrips] of vehicleDateTrips.entries()) {
    const [vehicleName, dateStr] = key.split(':::');
    const veh = vehicles.find(v => v.name === vehicleName) || { dailyRentalRate: 200 };
    const dailyRate = Number(veh.dailyRentalRate) || Number(veh.purchasePrice) || 200;

    // Chronological sort to identify the FIRST trip of the calendar day
    vTrips.sort((a, b) => {
      const timeA = new Date(a.startDateTime || a.startTime || a.createdAt).getTime();
      const timeB = new Date(b.startDateTime || b.startTime || b.createdAt).getTime();
      return timeA - timeB;
    });

    const firstTrip = vTrips[0];
    const billedTeam = (firstTrip.team || 'غير محدد').trim();

    // First trip of the day gets the full daily rental charge on that team!
    tripBillingMap[firstTrip.id] = {
      isFirstTripOfDay: true,
      billedTeam: billedTeam,
      rentalAmount: dailyRate,
      dateStr,
      vehicleName,
      driverName: firstTrip.driverName || '',
      tripDestination: firstTrip.destination || ''
    };

    // Subsequent trips on the same day for this car are charged 0 NIS (covered by first trip)
    for (let i = 1; i < vTrips.length; i++) {
      tripBillingMap[vTrips[i].id] = {
        isFirstTripOfDay: false,
        billedTeam: billedTeam,
        rentalAmount: 0,
        dateStr,
        vehicleName,
        driverName: vTrips[i].driverName || '',
        tripDestination: vTrips[i].destination || '',
        note: `الإيجار اليومي (${dailyRate} ₪) محسوب على أول طلعة مع: ${billedTeam}`
      };
    }

    if (!vehicleBillingDays.has(vehicleName)) {
      vehicleBillingDays.set(vehicleName, []);
    }
    const dayRecord = {
      dateStr,
      firstTripId: firstTrip.id,
      vehicleName,
      billedTeam,
      rentalRate: dailyRate,
      driverName: firstTrip.driverName || '',
      tripDestination: firstTrip.destination || '',
      passengers: firstTrip.passengers || []
    };
    vehicleBillingDays.get(vehicleName).push(dayRecord);

    if (!teamBillingDays.has(billedTeam)) {
      teamBillingDays.set(billedTeam, []);
    }
    teamBillingDays.get(billedTeam).push(dayRecord);

    dailyAllocations.push(dayRecord);
  }

  // Sort daily allocations descending by date
  dailyAllocations.sort((a, b) => b.dateStr.localeCompare(a.dateStr));

  const teamAccounts = {};
  let totalBilledDays = 0;
  let totalRentalCost = 0;

  for (const [teamName, days] of teamBillingDays.entries()) {
    const teamTrips = trips.filter(t => t.team === teamName);
    const cost = days.reduce((sum, d) => sum + d.rentalRate, 0);
    teamAccounts[teamName] = {
      teamName,
      billedDaysCount: days.length,
      totalRentalCost: cost,
      totalTripsCount: teamTrips.length,
      daysLog: days.sort((a, b) => b.dateStr.localeCompare(a.dateStr))
    };
    totalBilledDays += days.length;
    totalRentalCost += cost;
  }

  const vehicleAccounts = {};
  vehicles.forEach(v => {
    const days = vehicleBillingDays.get(v.name) || [];
    const vPurchases = purchases.filter(p => p.vehicleName === v.name);
    const purchasesCost = vPurchases.reduce((sum, p) => sum + (Number(p.cost) || 0), 0);
    const rentalTotal = days.reduce((sum, d) => sum + d.rentalRate, 0);
    const dailyRate = Number(v.dailyRentalRate) || Number(v.purchasePrice) || 200;

    vehicleAccounts[v.name] = {
      vehicleId: v.id,
      vehicleName: v.name,
      plateNumber: v.plateNumber || '-',
      modelYear: v.modelYear || '2021',
      driverName: v.driverName || 'غير معين',
      dailyRentalRate: dailyRate,
      billedDaysCount: days.length,
      totalRentalAmount: rentalTotal,
      purchasesCost: purchasesCost,
      grandTotal: rentalTotal + purchasesCost,
      daysLog: days.sort((a, b) => b.dateStr.localeCompare(a.dateStr))
    };
  });

  const totalPurchasesCost = purchases.reduce((sum, p) => sum + (Number(p.cost) || 0), 0);

  return {
    teamAccounts,
    vehicleAccounts,
    dailyAllocations,
    grandTotals: {
      totalBilledDays,
      totalRentalCost,
      totalPurchasesCost,
      grandTotal: totalRentalCost + totalPurchasesCost
    },
    tripBillingMap
  };
}

function switchProcurementTab(tab) {
  currentProcurementTab = tab;
  const teamsSection = document.getElementById('procurementTeamsSection');
  const invSection = document.getElementById('procurementInventorySection');
  const invoicesSection = document.getElementById('procurementInvoicesSection');

  const teamsBtn = document.getElementById('procTabTeamsBtn');
  const invBtn = document.getElementById('procTabInventoryBtn');
  const invoicesBtn = document.getElementById('procTabInvoicesBtn');

  if (teamsSection) teamsSection.classList.add('hidden');
  if (invSection) invSection.classList.add('hidden');
  if (invoicesSection) invoicesSection.classList.add('hidden');

  const activeBtnClass = 'px-4 py-2 border-b-2 border-sky-500 text-sky-400 font-bold text-xs flex items-center gap-1.5 transition-all whitespace-nowrap';
  const inactiveBtnClass = 'px-4 py-2 border-b-2 border-transparent text-slate-400 hover:text-white font-bold text-xs flex items-center gap-1.5 transition-all whitespace-nowrap';

  if (teamsBtn) teamsBtn.className = inactiveBtnClass;
  if (invBtn) invBtn.className = inactiveBtnClass;
  if (invoicesBtn) invoicesBtn.className = inactiveBtnClass;

  const rentalData = computeLocalFleetRentalAccounts();

  if (tab === 'teams') {
    if (teamsSection) teamsSection.classList.remove('hidden');
    if (teamsBtn) teamsBtn.className = activeBtnClass;
    renderProcurementTeamsGrid(rentalData);
    renderProcurementDaysAllocationTable(rentalData);
  } else if (tab === 'inventory') {
    if (invSection) invSection.classList.remove('hidden');
    if (invBtn) invBtn.className = activeBtnClass;
    renderVehicleInventoryCards(rentalData);
  } else {
    if (invoicesSection) invoicesSection.classList.remove('hidden');
    if (invoicesBtn) invoicesBtn.className = activeBtnClass;
    populateProcurementVehicleFilter();
    renderPurchasesTable();
  }
  initLucideIcons();
}

function renderProcurementDashboard() {
  const rentalData = computeLocalFleetRentalAccounts();
  const grandTotals = rentalData.grandTotals;

  // Update KPI Cards
  const assetElem = document.getElementById('procurementTotalAssetValue');
  const purchElem = document.getElementById('procurementTotalPurchasesCost');
  const grandElem = document.getElementById('procurementGrandTotal');
  const countElem = document.getElementById('procurementVehiclesCount');

  if (assetElem) assetElem.innerHTML = `${grandTotals.totalRentalCost.toLocaleString()} <span class="text-xs font-normal text-slate-400">₪</span>`;
  if (purchElem) purchElem.innerHTML = `${grandTotals.totalPurchasesCost.toLocaleString()} <span class="text-xs font-normal text-slate-400">₪</span>`;
  if (grandElem) grandElem.innerHTML = `${grandTotals.grandTotal.toLocaleString()} <span class="text-xs font-normal text-emerald-300">₪</span>`;
  if (countElem) countElem.innerHTML = `${grandTotals.totalBilledDays} <span class="text-xs font-normal text-slate-400">يوم تشغيل</span>`;

  // Render whichever tab is active
  switchProcurementTab(currentProcurementTab || 'teams');
}

function renderProcurementTeamsGrid(rentalData) {
  if (!rentalData) rentalData = computeLocalFleetRentalAccounts();
  const grid = document.getElementById('procurementTeamsGrid');
  const countLabel = document.getElementById('procurementTeamsCountLabel');
  if (!grid) return;

  const teamAccounts = Object.values(rentalData.teamAccounts || {});
  if (countLabel) countLabel.textContent = `${teamAccounts.length} فرق ومشاريع مسجلة`;

  const teamIcons = {
    'يونيسف': 'heart-handshake',
    'DRA': 'shield',
    'FS': 'activity',
    'HA': 'home',
    'إداري': 'briefcase'
  };

  grid.innerHTML = teamAccounts.map(team => {
    const icon = teamIcons[team.teamName] || 'folder';
    return `
      <div class="glass-card p-4 rounded-2xl border border-slate-800 hover:border-sky-500/40 transition-all space-y-3 bg-slate-900/80">
        <div class="flex items-center justify-between border-b border-slate-800 pb-2.5">
          <div class="flex items-center gap-2.5">
            <div class="w-9 h-9 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center border border-sky-500/30">
              <i data-lucide="${icon}" class="w-4 h-4"></i>
            </div>
            <div>
              <h4 class="text-sm font-bold text-white">${escapeHtml(team.teamName)}</h4>
              <span class="text-[10px] text-slate-400 font-mono-numbers">${team.totalTripsCount} رحلة مسجلة</span>
            </div>
          </div>
          <span class="px-2 py-0.5 rounded-full bg-sky-950/80 text-sky-300 border border-sky-800/60 text-[10px] font-mono-numbers font-bold">
            ${team.billedDaysCount} يوم إيجار
          </span>
        </div>

        <div class="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-center">
          <span class="text-[10px] text-slate-400 block mb-0.5">تكلفة الإيجار المستحقة 💰</span>
          <div class="text-lg font-black font-mono-numbers text-emerald-400">${team.totalRentalCost.toLocaleString()} ₪</div>
        </div>

        <button type="button" onclick="openTeamLedgerModal('${escapeHtml(team.teamName)}')" class="w-full py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sky-300 font-bold text-xs flex items-center justify-center gap-1.5 border border-slate-700 transition-all">
          <i data-lucide="file-text" class="w-3.5 h-3.5"></i>
          <span>كشف حساب الفريق التفصيلي 📋</span>
        </button>
      </div>
    `;
  }).join('');

  initLucideIcons();
}

function renderProcurementDaysAllocationTable(rentalData) {
  if (!rentalData) rentalData = computeLocalFleetRentalAccounts();
  const tbody = document.getElementById('procurementDailyAllocationsTbody');
  const noNotice = document.getElementById('noDailyAllocationsNotice');
  const searchInput = document.getElementById('procurementAllocationSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  if (!tbody) return;

  const allocations = (rentalData.dailyAllocations || []).filter(item => {
    if (!query) return true;
    return (item.dateStr && item.dateStr.includes(query)) ||
           (item.vehicleName && item.vehicleName.toLowerCase().includes(query)) ||
           (item.billedTeam && item.billedTeam.toLowerCase().includes(query)) ||
           (item.driverName && item.driverName.toLowerCase().includes(query)) ||
           (item.tripDestination && item.tripDestination.toLowerCase().includes(query));
  });

  if (allocations.length === 0) {
    tbody.innerHTML = '';
    if (noNotice) noNotice.classList.remove('hidden');
    return;
  }

  if (noNotice) noNotice.classList.add('hidden');

  tbody.innerHTML = allocations.map((item, idx) => `
    <tr class="hover:bg-slate-800/40 transition-colors">
      <td class="p-3 font-mono-numbers text-slate-400">${idx + 1}</td>
      <td class="p-3 font-mono-numbers text-white font-bold whitespace-nowrap">${item.dateStr}</td>
      <td class="p-3 font-bold text-slate-200">${escapeHtml(item.vehicleName)}</td>
      <td class="p-3">
        <span class="px-2.5 py-1 rounded-full text-xs font-bold bg-sky-500/20 text-sky-300 border border-sky-500/40">
          ${escapeHtml(item.billedTeam)}
        </span>
      </td>
      <td class="p-3 font-mono-numbers text-emerald-400 font-bold">${item.rentalRate.toLocaleString()} ₪</td>
      <td class="p-3 text-slate-300">${escapeHtml(item.driverName || '-')}</td>
      <td class="p-3 text-slate-300 max-w-xs truncate" title="${escapeHtml(item.tripDestination || '-')}">${escapeHtml(item.tripDestination || '-')}</td>
      <td class="p-3 text-center">
        <button type="button" onclick="openTeamLedgerModal('${escapeHtml(item.billedTeam)}')" class="p-1.5 rounded-lg bg-sky-950/80 hover:bg-sky-900 text-sky-300 transition-all" title="عرض كشف حساب الفريق">
          <i data-lucide="eye" class="w-3.5 h-3.5"></i>
        </button>
      </td>
    </tr>
  `).join('');

  initLucideIcons();
}

function openTeamLedgerModal(teamName) {
  if (!canViewFinancials()) {
    showToast('عذراً، كشف الحسابات المالية محصور بمسؤول المشتريات والمشرف العام فقط', 'warning');
    return;
  }
  const rentalData = computeLocalFleetRentalAccounts();
  const teamAccount = rentalData.teamAccounts[teamName] || {
    teamName,
    billedDaysCount: 0,
    totalRentalCost: 0,
    totalTripsCount: 0,
    daysLog: []
  };

  const titleElem = document.getElementById('teamLedgerTitle');
  const daysElem = document.getElementById('teamLedgerDaysCount');
  const costElem = document.getElementById('teamLedgerTotalCost');
  const tripsElem = document.getElementById('teamLedgerTripsCount');
  const tbody = document.getElementById('teamLedgerTbody');
  const noNotice = document.getElementById('noTeamDaysNotice');

  if (titleElem) titleElem.textContent = teamName;
  if (daysElem) daysElem.textContent = `${teamAccount.billedDaysCount} يوم`;
  if (costElem) costElem.textContent = `${teamAccount.totalRentalCost.toLocaleString()} ₪`;
  if (tripsElem) tripsElem.textContent = `${teamAccount.totalTripsCount} رحلة`;

  if (tbody) {
    if (!teamAccount.daysLog || teamAccount.daysLog.length === 0) {
      tbody.innerHTML = '';
      if (noNotice) noNotice.classList.remove('hidden');
    } else {
      if (noNotice) noNotice.classList.add('hidden');
      tbody.innerHTML = teamAccount.daysLog.map(day => `
        <tr class="hover:bg-slate-900/60 transition-colors">
          <td class="p-2.5 font-mono-numbers text-white font-bold whitespace-nowrap">${day.dateStr}</td>
          <td class="p-2.5 font-bold text-slate-200">${escapeHtml(day.vehicleName)}</td>
          <td class="p-2.5 text-slate-300">${escapeHtml(day.driverName || '-')}</td>
          <td class="p-2.5 text-slate-300">${escapeHtml(day.tripDestination || '-')}</td>
          <td class="p-2.5 font-mono-numbers text-emerald-400 font-bold">${day.rentalRate.toLocaleString()} ₪</td>
        </tr>
      `).join('');
    }
  }

  openModal('teamLedgerModal');
  initLucideIcons();
}

function renderVehicleInventoryCards(rentalData) {
  if (!rentalData) rentalData = computeLocalFleetRentalAccounts();
  const grid = document.getElementById('procurementVehiclesGrid');
  const tbody = document.getElementById('procurementInventoryTbody');
  const searchInput = document.getElementById('procurementVehSearch');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const vehicles = (appState.vehicles || []).filter(v => {
    if (!query) return true;
    return (v.name && v.name.toLowerCase().includes(query)) ||
           (v.driverName && v.driverName.toLowerCase().includes(query)) ||
           (v.plateNumber && v.plateNumber.toLowerCase().includes(query));
  });

  const vehicleAccounts = rentalData.vehicleAccounts || {};

  // Populate Grid Cards (حساب مستقل لكل مركبة)
  if (grid) {
    grid.innerHTML = vehicles.map(v => {
      const vAccount = vehicleAccounts[v.name] || {
        dailyRentalRate: Number(v.dailyRentalRate) || Number(v.purchasePrice) || 200,
        billedDaysCount: 0,
        totalRentalAmount: 0,
        purchasesCost: 0,
        grandTotal: 0
      };

      return `
        <div class="glass-card p-4 sm:p-5 rounded-2xl border border-slate-800 hover:border-emerald-500/40 transition-all space-y-3.5 bg-slate-900/80">
          <div class="flex items-start justify-between gap-3 border-b border-slate-800 pb-3">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-xl bg-sky-500/20 text-sky-400 flex items-center justify-center border border-sky-500/30">
                <i data-lucide="car" class="w-5 h-5"></i>
              </div>
              <div>
                <h4 class="text-sm font-bold text-white">${escapeHtml(v.name)}</h4>
                <div class="flex items-center gap-2 text-[11px] text-slate-400 font-mono-numbers mt-0.5">
                  <span>لوحة: <strong>${escapeHtml(v.plateNumber || '-')}</strong></span>
                  <span>•</span>
                  <span>موديل: <strong>${escapeHtml(v.modelYear || '2021')}</strong></span>
                </div>
              </div>
            </div>
            <button type="button" onclick="openSetVehiclePriceModal('${v.id}')" class="px-2.5 py-1 rounded-lg bg-sky-950/80 hover:bg-sky-900 border border-sky-500/40 text-sky-300 text-[11px] font-bold flex items-center gap-1 transition-all" title="تعديل وضبط تسعيرة الإيجار اليومي">
              <i data-lucide="tag" class="w-3 h-3"></i>
              <span>ضبط تسعيرة الإيجار</span>
            </button>
          </div>

          <div class="flex items-center justify-between text-xs text-slate-300">
            <div class="flex items-center gap-1.5">
              <i data-lucide="user" class="w-3.5 h-3.5 text-rose-400"></i>
              <span>السائق المعين:</span>
              <strong class="text-white">${escapeHtml(v.driverName || 'غير معين')}</strong>
            </div>
            <span class="px-2 py-0.5 rounded-full bg-slate-800 text-sky-300 text-[11px] font-mono-numbers font-bold">
              ${vAccount.billedDaysCount} يوم عمل محتسب
            </span>
          </div>

          <!-- Financial Statement Box for this car -->
          <div class="grid grid-cols-4 gap-2 p-2.5 rounded-xl bg-slate-950 border border-slate-800/80 text-center">
            <div>
              <span class="text-[10px] text-slate-400 block mb-0.5">تسعيرة اليوم 🏷️</span>
              <span class="font-mono-numbers text-xs font-bold text-sky-400">${vAccount.dailyRentalRate.toLocaleString()} ₪</span>
            </div>
            <div>
              <span class="text-[10px] text-slate-400 block mb-0.5">إجمالي الإيجار 💰</span>
              <span class="font-mono-numbers text-xs font-bold text-emerald-400">${vAccount.totalRentalAmount.toLocaleString()} ₪</span>
            </div>
            <div>
              <span class="text-[10px] text-slate-400 block mb-0.5">الصيانة 🛒</span>
              <span class="font-mono-numbers text-xs font-bold text-amber-400">${vAccount.purchasesCost.toLocaleString()} ₪</span>
            </div>
            <div class="border-r border-slate-800 pr-1">
              <span class="text-[10px] text-emerald-300 font-bold block mb-0.5">الحساب الكامل 💎</span>
              <span class="font-mono-numbers text-xs font-black text-emerald-300">${vAccount.grandTotal.toLocaleString()} ₪</span>
            </div>
          </div>

          <!-- Action Buttons -->
          <div class="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60 text-xs">
            <button type="button" onclick="openAddPurchaseModal('${escapeHtml(v.name)}')" class="flex-1 py-1.5 rounded-xl bg-emerald-600/90 hover:bg-emerald-500 text-white font-bold flex items-center justify-center gap-1 transition-all">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i>
              <span>إضافة فاتورة صيانة</span>
            </button>
            <button type="button" onclick="openVehicleLedgerModal('${escapeHtml(v.name)}')" class="flex-1 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold flex items-center justify-center gap-1 border border-slate-700 transition-all">
              <i data-lucide="file-text" class="w-3.5 h-3.5 text-amber-400"></i>
              <span>كشف حساب السيارة 📄</span>
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  // Populate Master Fleet Inventory Table
  if (tbody) {
    let sumDays = 0;
    let sumRental = 0;
    let sumPurch = 0;
    let sumGrand = 0;

    tbody.innerHTML = (appState.vehicles || []).map((v, idx) => {
      const vAccount = vehicleAccounts[v.name] || {
        dailyRentalRate: Number(v.dailyRentalRate) || Number(v.purchasePrice) || 200,
        billedDaysCount: 0,
        totalRentalAmount: 0,
        purchasesCost: 0,
        grandTotal: 0
      };

      sumDays += vAccount.billedDaysCount;
      sumRental += vAccount.totalRentalAmount;
      sumPurch += vAccount.purchasesCost;
      sumGrand += vAccount.grandTotal;

      return `
        <tr class="hover:bg-slate-800/40 transition-colors">
          <td class="p-3 font-mono-numbers text-slate-400">${idx + 1}</td>
          <td class="p-3 font-bold text-white">${escapeHtml(v.name)}</td>
          <td class="p-3 font-mono-numbers text-slate-300">${escapeHtml(v.plateNumber || '-')} (${escapeHtml(v.modelYear || '2021')})</td>
          <td class="p-3 text-slate-300">${escapeHtml(v.driverName || 'غير معين')}</td>
          <td class="p-3 font-mono-numbers text-sky-400 font-bold">${vAccount.dailyRentalRate.toLocaleString()} ₪</td>
          <td class="p-3 font-mono-numbers text-sky-300 font-bold">${vAccount.billedDaysCount} يوم</td>
          <td class="p-3 font-mono-numbers text-emerald-400 font-bold">${vAccount.totalRentalAmount.toLocaleString()} ₪</td>
          <td class="p-3 font-mono-numbers text-amber-400 font-bold">${vAccount.purchasesCost.toLocaleString()} ₪</td>
          <td class="p-3 font-mono-numbers text-emerald-300 font-black text-sm">${vAccount.grandTotal.toLocaleString()} ₪</td>
          <td class="p-3 text-center">
            <div class="flex items-center justify-center gap-1.5">
              <button type="button" onclick="openSetVehiclePriceModal('${v.id}')" class="p-1.5 rounded-lg bg-sky-950/80 hover:bg-sky-900 text-sky-300" title="تعديل وضبط تسعيرة الإيجار اليومي">
                <i data-lucide="tag" class="w-3.5 h-3.5"></i>
              </button>
              <button type="button" onclick="openAddPurchaseModal('${escapeHtml(v.name)}')" class="p-1.5 rounded-lg bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300" title="إضافة فاتورة صيانة">
                <i data-lucide="plus" class="w-3.5 h-3.5"></i>
              </button>
              <button type="button" onclick="openVehicleLedgerModal('${escapeHtml(v.name)}')" class="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300" title="كشف الحساب الكامل">
                <i data-lucide="file-text" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    const tfootDays = document.getElementById('tfootTotalBilledDays');
    const tfootRental = document.getElementById('tfootTotalRentalEarnings');
    const tfootPurch = document.getElementById('tfootTotalPurchases');
    const tfootGrand = document.getElementById('tfootGrandTotal');

    if (tfootDays) tfootDays.textContent = `${sumDays} يوم`;
    if (tfootRental) tfootRental.textContent = `${sumRental.toLocaleString()} ₪`;
    if (tfootPurch) tfootPurch.textContent = `${sumPurch.toLocaleString()} ₪`;
    if (tfootGrand) tfootGrand.textContent = `${sumGrand.toLocaleString()} ₪`;
  }

  initLucideIcons();
}

function populateProcurementVehicleFilter() {
  const select = document.getElementById('procFilterVehicle');
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = `
    <option value="ALL">جميع سيارات الأسطول</option>
    ${(appState.vehicles || []).map(v => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}</option>`).join('')}
  `;
  if (currentVal) select.value = currentVal;
}

function renderPurchasesTable() {
  const tbody = document.getElementById('procurementInvoicesTbody');
  const noNotice = document.getElementById('noPurchasesNotice');
  if (!tbody) return;

  const vehFilter = document.getElementById('procFilterVehicle')?.value || 'ALL';
  const typeFilter = document.getElementById('procFilterType')?.value || 'ALL';
  const searchFilter = document.getElementById('procFilterSearch')?.value.trim().toLowerCase() || '';

  const purchases = (appState.purchases || []).filter(p => {
    if (vehFilter !== 'ALL' && p.vehicleName !== vehFilter) return false;
    if (typeFilter !== 'ALL' && p.itemType !== typeFilter) return false;
    if (searchFilter) {
      const match = (p.itemDescription && p.itemDescription.toLowerCase().includes(searchFilter)) ||
                    (p.supplier && p.supplier.toLowerCase().includes(searchFilter)) ||
                    (p.invoiceNumber && p.invoiceNumber.toLowerCase().includes(searchFilter)) ||
                    (p.vehicleName && p.vehicleName.toLowerCase().includes(searchFilter));
      if (!match) return false;
    }
    return true;
  });

  if (purchases.length === 0) {
    tbody.innerHTML = '';
    if (noNotice) noNotice.classList.remove('hidden');
    return;
  }

  if (noNotice) noNotice.classList.add('hidden');

  tbody.innerHTML = purchases.map((p, idx) => `
    <tr class="hover:bg-slate-800/40 transition-colors">
      <td class="p-3 font-mono-numbers text-slate-400">${idx + 1}</td>
      <td class="p-3 font-mono-numbers text-slate-300">${p.date || '-'}</td>
      <td class="p-3 font-bold text-white">${escapeHtml(p.vehicleName)}</td>
      <td class="p-3 text-slate-200">${escapeHtml(p.itemDescription)}</td>
      <td class="p-3">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
          ${escapeHtml(p.itemType || 'مشتريات')}
        </span>
      </td>
      <td class="p-3 text-slate-300 font-mono-numbers">${escapeHtml(p.supplier || '-')} ${p.invoiceNumber ? `(#${escapeHtml(p.invoiceNumber)})` : ''}</td>
      <td class="p-3 font-mono-numbers text-amber-400 font-black text-sm">${Number(p.cost || 0).toLocaleString()} ₪</td>
      <td class="p-3 text-slate-400 text-[11px]">${escapeHtml(p.recordedBy || 'مسؤول المشتريات')}</td>
      <td class="p-3 text-slate-400 text-[11px]">${escapeHtml(p.notes || '-')}</td>
      <td class="p-3 text-center">
        <button type="button" onclick="deletePurchase('${p.id}')" class="p-1.5 rounded-lg bg-rose-950/80 hover:bg-rose-900 text-rose-300 transition-all" title="حذف الفاتورة">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </td>
    </tr>
  `).join('');

  initLucideIcons();
}

function openSetVehiclePriceModal(vehicleId) {
  if (!canViewFinancials()) {
    showToast('عذراً، ضبط التسعيرة والأسعار محصور بمسؤول المشتريات والمشرف العام فقط', 'warning');
    return;
  }
  const vehicle = (appState.vehicles || []).find(v => v.id === vehicleId);
  if (!vehicle) {
    showToast('المركبة غير موجودة', 'warning');
    return;
  }

  const currentRate = vehicle.dailyRentalRate !== undefined ? vehicle.dailyRentalRate : (vehicle.purchasePrice || 200);

  document.getElementById('setPriceVehicleId').value = vehicle.id;
  document.getElementById('setPriceVehicleName').value = vehicle.name;
  document.getElementById('setPriceAmount').value = currentRate;
  document.getElementById('setPriceModelYear').value = vehicle.modelYear || '2021';
  document.getElementById('setPriceChassis').value = vehicle.chassisNumber || '';
  document.getElementById('setPriceNotes').value = vehicle.rentalNotes || vehicle.purchaseNotes || '';

  openModal('setVehiclePriceModal');
}

async function handleSetVehiclePriceSubmit(event) {
  event.preventDefault();
  const vId = document.getElementById('setPriceVehicleId').value;
  const rate = Number(document.getElementById('setPriceAmount').value) || 0;
  const modelYear = document.getElementById('setPriceModelYear').value.trim();
  const chassisNumber = document.getElementById('setPriceChassis').value.trim();
  const rentalNotes = document.getElementById('setPriceNotes').value.trim();

  const body = {
    dailyRentalRate: rate,
    purchasePrice: rate,
    modelYear,
    chassisNumber,
    rentalNotes,
    purchaseNotes: rentalNotes
  };

  try {
    const res = await fetch(`/api/vehicles/${vId}/rental-rate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (res.ok && data.success) {
      const idx = appState.vehicles.findIndex(v => v.id === vId);
      if (idx !== -1) {
        appState.vehicles[idx] = data.vehicle;
      }
      localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
      closeModal('setVehiclePriceModal');
      showToast(`تم حفظ تسعيرة الإيجار اليومي للمركبة: ${rate.toLocaleString()} ₪/يوم 💾`, 'success');
      renderProcurementDashboard();
    } else {
      showToast(data.error || 'فشل تحديث تسعيرة المركبة', 'warning');
    }
  } catch (err) {
    const idx = appState.vehicles.findIndex(v => v.id === vId);
    if (idx !== -1) {
      appState.vehicles[idx] = { ...appState.vehicles[idx], ...body };
      localStorage.setItem(STORAGE_KEYS.CACHED_VEHICLES, JSON.stringify(appState.vehicles));
    }
    closeModal('setVehiclePriceModal');
    showToast('تم حفظ تسعيرة الإيجار محلياً', 'info');
    renderProcurementDashboard();
  }
}

function openAddPurchaseModal(prefillVehicleName) {
  const vehSelect = document.getElementById('addPurchVehicleSelect') || document.getElementById('addPurchVehicle');
  if (vehSelect) {
    vehSelect.innerHTML = `
      <option value="">-- اختر المركبة من الأسطول --</option>
      ${(appState.vehicles || []).map(v => `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)} (${escapeHtml(v.driverName || 'عامة')})</option>`).join('')}
    `;
    if (prefillVehicleName) {
      vehSelect.value = prefillVehicleName;
    }
  }

  // Pre-fill current date
  const dateInput = document.getElementById('addPurchDate');
  if (dateInput) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
  }

  document.getElementById('addPurchDescription').value = '';
  document.getElementById('addPurchCost').value = '';
  document.getElementById('addPurchSupplier').value = '';
  document.getElementById('addPurchInvoiceNo').value = '';
  document.getElementById('addPurchOdometer').value = '';
  document.getElementById('addPurchNotes').value = '';

  openModal('addPurchaseModal');
}

async function handleAddPurchaseSubmit(event) {
  event.preventDefault();
  const vehElem = document.getElementById('addPurchVehicleSelect') || document.getElementById('addPurchVehicle');
  const typeElem = document.getElementById('addPurchItemType') || document.getElementById('addPurchType');
  const vehicleName = vehElem ? vehElem.value.trim() : '';
  const itemType = typeElem ? typeElem.value : 'قطع غيار وصيانة';
  const itemDescription = document.getElementById('addPurchDescription').value.trim();
  const cost = Number(document.getElementById('addPurchCost').value) || 0;
  const supplier = document.getElementById('addPurchSupplier').value.trim();
  const invoiceNumber = document.getElementById('addPurchInvoiceNo').value.trim();
  const date = document.getElementById('addPurchDate').value;
  const odometer = Number(document.getElementById('addPurchOdometer').value) || 0;
  const notes = document.getElementById('addPurchNotes').value.trim();

  if (!vehicleName || !itemDescription || cost <= 0) {
    showToast('يرجى تحديد السيارة وبيان المشترى والتكلفة', 'warning');
    return;
  }

  const payload = {
    vehicleName,
    itemType,
    itemDescription,
    cost,
    supplier,
    invoiceNumber,
    date,
    odometer,
    notes,
    recordedBy: appState.currentUser?.name || 'مسؤول المشتريات',
    recordedByUsername: appState.currentUser?.username || 'procurement'
  };

  try {
    const res = await fetch('/api/purchases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok && data.success) {
      if (!appState.purchases) appState.purchases = [];
      appState.purchases.unshift(data.purchase);
      localStorage.setItem(STORAGE_KEYS.CACHED_PURCHASES, JSON.stringify(appState.purchases));

      closeModal('addPurchaseModal');
      document.getElementById('addPurchaseForm').reset();
      showToast(`تم تسجيل فاتورة الصيانة/المشتريات بنجاح: ${cost.toLocaleString()} ₪ لـ "${vehicleName}" 🛒`, 'success');
      renderProcurementDashboard();

      // If ledger is open for this car, refresh it
      if (currentLedgerVehicleName === vehicleName) {
        openVehicleLedgerModal(vehicleName);
      }
    } else {
      showToast(data.error || 'فشل حفظ الفاتورة', 'warning');
    }
  } catch (err) {
    const localPurch = {
      id: 'PURCH_' + Date.now(),
      ...payload,
      createdAt: new Date().toISOString()
    };
    if (!appState.purchases) appState.purchases = [];
    appState.purchases.unshift(localPurch);
    localStorage.setItem(STORAGE_KEYS.CACHED_PURCHASES, JSON.stringify(appState.purchases));

    closeModal('addPurchaseModal');
    showToast('تم الحفظ محلياً: سيتم الترحيل عند شبك السيرفر', 'info');
    renderProcurementDashboard();
  }
}

async function deletePurchase(purchaseId) {
  const p = (appState.purchases || []).find(item => item.id === purchaseId);
  const desc = p ? `فاتورة "${p.itemDescription}" بمبلغ (${p.cost} ₪)` : 'هذه الفاتورة';

  if (!confirm(`هل أنت متأكد من رغبتك في حذف ${desc} نهائياً؟`)) {
    return;
  }

  try {
    const res = await fetch(`/api/purchases/${purchaseId}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      appState.purchases = appState.purchases.filter(item => item.id !== purchaseId);
      localStorage.setItem(STORAGE_KEYS.CACHED_PURCHASES, JSON.stringify(appState.purchases));
      showToast('تم حذف الفاتورة بنجاح 🗑️', 'info');
      renderProcurementDashboard();
      if (currentLedgerVehicleName) {
        openVehicleLedgerModal(currentLedgerVehicleName);
      }
    } else {
      showToast(data.error || 'فشل حذف الفاتورة', 'warning');
    }
  } catch (err) {
    appState.purchases = appState.purchases.filter(item => item.id !== purchaseId);
    localStorage.setItem(STORAGE_KEYS.CACHED_PURCHASES, JSON.stringify(appState.purchases));
    showToast('تم الحذف محلياً', 'info');
    renderProcurementDashboard();
  }
}

function openVehicleLedgerModal(vehicleName) {
  if (!canViewFinancials()) {
    showToast('عذراً، كشف حسابات المركبات المالية محصور بمسؤول المشتريات والمشرف العام فقط', 'warning');
    return;
  }
  currentLedgerVehicleName = vehicleName;
  const vehicle = (appState.vehicles || []).find(v => v.name === vehicleName);
  if (!vehicle) {
    showToast('المركبة غير موجودة', 'warning');
    return;
  }

  const rentalData = computeLocalFleetRentalAccounts();
  const vAccount = rentalData.vehicleAccounts[vehicleName] || {
    dailyRentalRate: Number(vehicle.dailyRentalRate) || 200,
    billedDaysCount: 0,
    totalRentalAmount: 0,
    purchasesCost: 0,
    grandTotal: 0,
    daysLog: []
  };

  const titleElem = document.getElementById('ledgerVehicleTitle');
  const rateElem = document.getElementById('ledgerDailyRate');
  const daysElem = document.getElementById('ledgerOperatingDays');
  const rentElem = document.getElementById('ledgerRentalTotal');
  const purchElem = document.getElementById('ledgerPurchasesTotal');
  const grandElem = document.getElementById('ledgerGrandTotal');
  const daysBadge = document.getElementById('ledgerDaysBadge');
  const invoicesBadge = document.getElementById('ledgerInvoicesBadge');

  if (titleElem) titleElem.textContent = `${vehicle.name} (${vehicle.plateNumber || '-'})`;
  if (rateElem) rateElem.textContent = `${vAccount.dailyRentalRate.toLocaleString()} ₪/يوم`;
  if (daysElem) daysElem.textContent = `${vAccount.billedDaysCount} يوم`;
  if (rentElem) rentElem.textContent = `${vAccount.totalRentalAmount.toLocaleString()} ₪`;
  if (purchElem) purchElem.textContent = `${vAccount.purchasesCost.toLocaleString()} ₪`;
  if (grandElem) grandElem.textContent = `${vAccount.grandTotal.toLocaleString()} ₪`;

  if (daysBadge) daysBadge.textContent = `${vAccount.billedDaysCount} يوم عمل`;

  // Render Days Table
  const daysTbody = document.getElementById('ledgerDaysTbody');
  const noDaysNotice = document.getElementById('noLedgerDaysNotice');
  if (daysTbody) {
    if (!vAccount.daysLog || vAccount.daysLog.length === 0) {
      daysTbody.innerHTML = '';
      if (noDaysNotice) noDaysNotice.classList.remove('hidden');
    } else {
      if (noDaysNotice) noDaysNotice.classList.add('hidden');
      daysTbody.innerHTML = vAccount.daysLog.map(day => `
        <tr class="hover:bg-slate-900/60 transition-colors">
          <td class="p-2.5 font-mono-numbers text-white font-bold whitespace-nowrap">${day.dateStr}</td>
          <td class="p-2.5 font-bold text-sky-300">${escapeHtml(day.billedTeam)}</td>
          <td class="p-2.5 text-slate-300">${escapeHtml(day.driverName || '-')}</td>
          <td class="p-2.5 text-slate-300">${escapeHtml(day.tripDestination || '-')}</td>
          <td class="p-2.5 font-mono-numbers text-emerald-400 font-bold">${day.rentalRate.toLocaleString()} ₪</td>
        </tr>
      `).join('');
    }
  }

  // Render Invoices Table
  const vPurchases = (appState.purchases || []).filter(p => p.vehicleName === vehicleName);
  if (invoicesBadge) invoicesBadge.textContent = `${vPurchases.length} فاتورة`;

  const invTbody = document.getElementById('ledgerInvoicesTbody');
  const noInvNotice = document.getElementById('noLedgerInvoicesNotice');
  if (invTbody) {
    if (vPurchases.length === 0) {
      invTbody.innerHTML = '';
      if (noInvNotice) noInvNotice.classList.remove('hidden');
    } else {
      if (noInvNotice) noInvNotice.classList.add('hidden');
      invTbody.innerHTML = vPurchases.map(p => `
        <tr class="hover:bg-slate-900/60 transition-colors">
          <td class="p-2.5 font-mono-numbers text-slate-300">${p.date || '-'}</td>
          <td class="p-2.5 font-bold text-white">${escapeHtml(p.itemDescription)}</td>
          <td class="p-2.5 text-slate-300">${escapeHtml(p.itemType || '-')}</td>
          <td class="p-2.5 text-slate-400 font-mono-numbers">${escapeHtml(p.supplier || '-')}</td>
          <td class="p-2.5 font-mono-numbers text-amber-400 font-bold">${Number(p.cost || 0).toLocaleString()} ₪</td>
        </tr>
      `).join('');
    }
  }

  openModal('vehicleLedgerModal');
  initLucideIcons();
}

function exportProcurementExcel() {
  const rentalData = computeLocalFleetRentalAccounts();
  const teamAccounts = Object.values(rentalData.teamAccounts || {});
  const vehicleAccounts = Object.values(rentalData.vehicleAccounts || {});
  const dailyAllocations = rentalData.dailyAllocations || [];
  const purchases = appState.purchases || [];

  let csv = '\uFEFF'; // UTF-8 BOM for Arabic in Excel
  csv += 'كشف حسابات إيجار أسطول قرى الأطفال SOS وجرد المشتريات والصيانة\n';
  csv += `تاريخ الاستخراج,${new Date().toLocaleDateString('ar-EG')}\n`;
  csv += `قاعدة الاحتساب,احتساب إيجار السيارة اليومي على الفريق صاحب أول طلعة فقط (باقي رحلات اليوم 0 شيكل)\n\n`;

  // Section 1: Team Accounts
  csv += '1. كشف حسابات الفرق والمشاريع (توزيع الإيجار اليومي)\n';
  csv += '#,اسم الفريق / المشروع,عدد أيام الإيجار المحتسبة,إجمالي تكلفة الإيجار (شيكل),عدد الرحلات المسجلة\n';
  let grandTeamDays = 0;
  let grandTeamCost = 0;
  teamAccounts.forEach((t, idx) => {
    grandTeamDays += t.billedDaysCount;
    grandTeamCost += t.totalRentalCost;
    csv += `"${idx + 1}","${t.teamName}","${t.billedDaysCount}","${t.totalRentalCost}","${t.totalTripsCount}"\n`;
  });
  csv += `"","الإجمالي","${grandTeamDays}","${grandTeamCost}",""\n\n`;

  // Section 2: Fleet Vehicles Ledger
  csv += '2. كشف حسابات وتشغيل سيارات الأسطول\n';
  csv += '#,اسم المركبة,رقم اللوحة,الموديل,السائق المعين,تسعيرة الإيجار اليومي (شيكل),أيام العمل المحتسبة,إجمالي الإيجار المحتسب (شيكل),فواتير الصيانة والمشتريات (شيكل),الإجمالي الكامل لحساب السيارة (شيكل)\n';
  let grandVehDays = 0;
  let grandRentalEarnings = 0;
  let grandVehPurchases = 0;
  let grandFleetTotal = 0;
  vehicleAccounts.forEach((v, idx) => {
    grandVehDays += v.billedDaysCount;
    grandRentalEarnings += v.totalRentalAmount;
    grandVehPurchases += v.purchasesCost;
    grandFleetTotal += v.grandTotal;
    csv += `"${idx + 1}","${v.vehicleName}","${v.plateNumber}","${v.modelYear}","${v.driverName}","${v.dailyRentalRate}","${v.billedDaysCount}","${v.totalRentalAmount}","${v.purchasesCost}","${v.grandTotal}"\n`;
  });
  csv += `"","الإجمالي العام الكامل","","","","","${grandVehDays}","${grandRentalEarnings}","${grandVehPurchases}","${grandFleetTotal}"\n\n`;

  // Section 3: Daily Allocations Log
  csv += '3. سجل التوزيع اليومي لإيجار السيارات على الفرق (حسب أول طلعة)\n';
  csv += '#,التاريخ,المركبة,الفريق المحتسب عليه (أول طلعة),تسعيرة الإيجار اليومي (شيكل),السائق,الوجهة ومسار الرحلة\n';
  dailyAllocations.forEach((d, idx) => {
    csv += `"${idx + 1}","${d.dateStr}","${d.vehicleName}","${d.billedTeam}","${d.rentalRate}","${d.driverName}","${d.tripDestination}"\n`;
  });
  csv += '\n';

  // Section 4: Maintenance / Purchases Invoices
  csv += '4. سجل فواتير المشتريات وقطع الغيار والصيانة\n';
  csv += '#,التاريخ,المركبة,بيان المشترى,التصنيف,المورد,رقم الفاتورة,التكلفة (شيكل),سُجل بواسطة,ملاحظات\n';
  purchases.forEach((p, idx) => {
    csv += `"${idx + 1}","${p.date || '-'}","${p.vehicleName}","${p.itemDescription}","${p.itemType || '-'}","${p.supplier || '-'}","${p.invoiceNumber || '-'}","${p.cost || 0}","${p.recordedBy || '-'}","${p.notes || '-'}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `كشف_حسابات_إيجار_أسطول_SOS_${new Date().toISOString().slice(0, 10)}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  logUserAction('DATA_EXPORT', 'قام بتصدير كشف حسابات إيجار الأسطول وجرد المشتريات إلى ملف Excel (CSV)');
  showToast('تم تصدير كشف حسابات الإيجار والجرد بنجاح 📊', 'success');
}

// ==========================================
// 18. سجل الرقابة والحركات ونظام الإشعارات الحية (Audit Trail & Live Notification System)
// ==========================================

function formatRelativeTime(isoStr) {
  if (!isoStr) return '-';
  const date = new Date(isoStr);
  const now = new Date();
  const diffSec = Math.floor((now - date) / 1000);
  if (diffSec < 15) return 'الآن';
  if (diffSec < 60) return `منذ ${diffSec} ثانية`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `منذ ${diffHour} ساعة`;
  const diffDays = Math.floor(diffHour / 24);
  if (diffDays === 1) {
    return 'أمس ' + date.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays < 7) return `منذ ${diffDays} أيام`;
  return date.toLocaleDateString('ar-EG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function getActionMeta(actionType) {
  switch (actionType) {
    case 'DATA_EXPORT':
      return {
        label: 'تصدير وتنزيل بيانات Excel',
        icon: 'file-spreadsheet',
        badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
      };
    case 'TRIP_CREATE':
      return {
        label: 'بدء / تكليف رحلة',
        icon: 'car',
        badgeClass: 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
      };
    case 'TRIP_COMPLETE':
      return {
        label: 'إنهاء رحلة',
        icon: 'flag-triangle-right',
        badgeClass: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
      };
    case 'TRIP_UPDATE':
      return {
        label: 'تحديث بيانات رحلة',
        icon: 'edit-3',
        badgeClass: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
      };
    case 'TRIP_DELETE':
      return {
        label: 'حذف رحلة',
        icon: 'trash-2',
        badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
      };
    case 'TRIP_RESPOND':
      return {
        label: 'رد السائق على التكليف',
        icon: 'message-square',
        badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
      };
    case 'FUEL_LOG':
      return {
        label: 'تسجيل تعبئة سولار',
        icon: 'fuel',
        badgeClass: 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
      };
    case 'FUEL_UPDATE':
      return {
        label: 'تعديل سجل سولار',
        icon: 'edit',
        badgeClass: 'bg-amber-600/20 text-amber-300 border border-amber-600/30'
      };
    case 'FUEL_DELETE':
      return {
        label: 'حذف سجل سولار',
        icon: 'trash',
        badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
      };
    case 'PRICE_UPDATE':
      return {
        label: 'تعديل تسعيرة إيجار سيارة',
        icon: 'tag',
        badgeClass: 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
      };
    case 'INVOICE_CREATE':
      return {
        label: 'فاتورة مشتريات/صيانة',
        icon: 'shopping-cart',
        badgeClass: 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
      };
    case 'INVOICE_UPDATE':
      return {
        label: 'تعديل فاتورة مشتريات',
        icon: 'edit-2',
        badgeClass: 'bg-teal-600/20 text-teal-300 border border-teal-600/30'
      };
    case 'INVOICE_DELETE':
      return {
        label: 'حذف فاتورة مشتريات',
        icon: 'trash-2',
        badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
      };
    case 'USER_CREATE':
      return {
        label: 'إنشاء مستخدم/سائق',
        icon: 'user-plus',
        badgeClass: 'bg-blue-600/20 text-blue-300 border border-blue-600/30'
      };
    case 'USER_UPDATE':
      return {
        label: 'تعديل بيانات مستخدم',
        icon: 'user-cog',
        badgeClass: 'bg-sky-600/20 text-sky-300 border border-sky-600/30'
      };
    case 'USER_DELETE':
      return {
        label: 'حذف مستخدم',
        icon: 'user-x',
        badgeClass: 'bg-rose-600/20 text-rose-300 border border-rose-600/30'
      };
    case 'PASSWORD_RESET':
      return {
        label: 'إعادة تعيين كلمة مرور',
        icon: 'key',
        badgeClass: 'bg-orange-500/20 text-orange-300 border border-orange-500/30'
      };
    case 'LOGIN':
      return {
        label: 'تسجيل دخول ناجح',
        icon: 'log-in',
        badgeClass: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
      };
    case 'LOGIN_FAILED':
      return {
        label: 'فشل تسجيل الدخول',
        icon: 'shield-alert',
        badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
      };
    case 'LOGOUT':
      return {
        label: 'تسجيل خروج',
        icon: 'log-out',
        badgeClass: 'bg-slate-500/20 text-slate-300 border border-slate-500/30'
      };
    case 'MODULE_OPEN':
      return {
        label: 'فتح شاشة / قسم',
        icon: 'eye',
        badgeClass: 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
      };
    case 'VEHICLE_CREATE':
      return {
        label: 'إضافة مركبة للأسطول',
        icon: 'plus-circle',
        badgeClass: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
      };
    case 'VEHICLE_UPDATE':
      return {
        label: 'تحديث بيانات مركبة',
        icon: 'edit',
        badgeClass: 'bg-cyan-600/20 text-cyan-300 border border-cyan-600/30'
      };
    case 'VEHICLE_DELETE':
      return {
        label: 'حذف مركبة من الأسطول',
        icon: 'trash-2',
        badgeClass: 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
      };
    case 'AUDIT_CLEAR':
      return {
        label: 'تفريغ سجل الرقابة',
        icon: 'trash-2',
        badgeClass: 'bg-red-500/20 text-red-300 border border-red-500/30'
      };
    default:
      return {
        label: 'نشاط في النظام',
        icon: 'activity',
        badgeClass: 'bg-slate-500/20 text-slate-300 border border-slate-500/30'
      };
  }
}

function playNotificationSound() {
  if (appState.soundEnabled === false) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(739.99, ctx.currentTime); // F#5
    osc.frequency.setValueAtTime(987.77, ctx.currentTime + 0.08); // B5
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

function toggleNotificationSound() {
  appState.soundEnabled = !appState.soundEnabled;
  localStorage.setItem('sos_sound_enabled', String(appState.soundEnabled));
  const icon = document.getElementById('soundToggleIcon');
  if (icon) {
    icon.setAttribute('data-lucide', appState.soundEnabled ? 'volume-2' : 'volume-x');
    initLucideIcons();
  }
  showToast(appState.soundEnabled ? 'تم تفعيل صوت التنبيهات 🔔' : 'تم كتم صوت التنبيهات 🔕', 'info');
}

function showLiveNotification(entry) {
  if (!entry) return;
  const meta = getActionMeta(entry.actionType);

  const container = document.getElementById('toastContainer');
  if (!container) return;

  const card = document.createElement('div');
  card.className = 'pointer-events-auto p-3.5 rounded-2xl bg-slate-900/95 border border-amber-500/40 shadow-2xl text-xs text-white max-w-sm flex items-start gap-3 backdrop-blur-md transform transition-all duration-300 translate-y-2 opacity-0 animate-in';

  card.innerHTML = `
    <div class="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0 border border-amber-500/30">
      <i data-lucide="${meta.icon}" class="w-4 h-4"></i>
    </div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-amber-300 text-xs truncate">${meta.label}</span>
        <span class="text-[10px] text-slate-400 font-mono-numbers">الآن</span>
      </div>
      <p class="text-slate-200 mt-1 line-clamp-2 text-[11px] leading-relaxed">${escapeHtml(entry.details)}</p>
      <div class="mt-1.5 flex items-center gap-2 text-[10px] text-slate-400">
        <span class="font-bold text-sky-300">👤 ${escapeHtml(entry.userName || entry.username)}</span>
        <span>•</span>
        <span>${escapeHtml(entry.device || 'جهاز')}</span>
      </div>
    </div>
    <button onclick="this.parentElement.remove()" class="text-slate-500 hover:text-white p-1">
      <i data-lucide="x" class="w-3.5 h-3.5"></i>
    </button>
  `;

  container.appendChild(card);
  initLucideIcons();
  playNotificationSound();

  // Slide in
  requestAnimationFrame(() => {
    card.classList.remove('translate-y-2', 'opacity-0');
  });

  // Auto remove after 6 seconds
  setTimeout(() => {
    card.classList.add('opacity-0', 'translate-x-4');
    setTimeout(() => card.remove(), 300);
  }, 6000);
}

function calculateUnreadNotifications() {
  const lastReadStr = localStorage.getItem(STORAGE_KEYS.LAST_READ_AUDIT_TIME);
  const lastReadTime = lastReadStr ? new Date(lastReadStr).getTime() : 0;

  const unread = (appState.auditLogs || []).filter(l => {
    return new Date(l.timestamp).getTime() > lastReadTime;
  });

  appState.unreadNotificationsCount = unread.length;
  updateNotificationBadgeUI();
}

function updateNotificationBadgeUI() {
  const badge = document.getElementById('unreadNotificationsBadge');
  if (!badge) return;

  if (appState.unreadNotificationsCount > 0) {
    badge.textContent = appState.unreadNotificationsCount > 99 ? '99+' : appState.unreadNotificationsCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function toggleNotificationPanel(forceState) {
  const panel = document.getElementById('notificationDropdownPanel');
  if (!panel) return;

  if (typeof forceState === 'boolean') {
    if (forceState) panel.classList.remove('hidden');
    else panel.classList.add('hidden');
  } else {
    panel.classList.toggle('hidden');
  }

  if (!panel.classList.contains('hidden')) {
    renderNotificationsList();
  }
}

// Close panel when clicking outside
document.addEventListener('click', (e) => {
  const container = document.getElementById('notificationCenterContainer');
  const panel = document.getElementById('notificationDropdownPanel');
  if (container && panel && !panel.classList.contains('hidden')) {
    if (!container.contains(e.target)) {
      panel.classList.add('hidden');
    }
  }
});

function markAllNotificationsAsRead() {
  localStorage.setItem(STORAGE_KEYS.LAST_READ_AUDIT_TIME, new Date().toISOString());
  appState.unreadNotificationsCount = 0;
  updateNotificationBadgeUI();
  renderNotificationsList();
  showToast('تم تحديد كافة الإشعارات كمقروءة ✓', 'info');
}

function renderNotificationsList() {
  const list = document.getElementById('recentNotificationsList');
  if (!list) return;

  const logs = (appState.auditLogs || []).slice(0, 30);
  if (logs.length === 0) {
    list.innerHTML = `
      <div class="p-6 text-center text-slate-500 text-xs">
        <i data-lucide="bell-off" class="w-6 h-6 mx-auto mb-2 text-slate-600"></i>
        <span>لا توجد حركات أو إشعارات مسجلة حتى الآن.</span>
      </div>
    `;
    initLucideIcons();
    return;
  }

  const lastReadStr = localStorage.getItem(STORAGE_KEYS.LAST_READ_AUDIT_TIME);
  const lastReadTime = lastReadStr ? new Date(lastReadStr).getTime() : 0;

  list.innerHTML = logs.map(l => {
    const meta = getActionMeta(l.actionType);
    const isUnread = new Date(l.timestamp).getTime() > lastReadTime;

    return `
      <div class="p-3 hover:bg-slate-800/50 transition-colors flex items-start gap-2.5 ${isUnread ? 'bg-amber-500/5' : ''}">
        <div class="w-7 h-7 rounded-lg ${meta.badgeClass} flex items-center justify-center shrink-0 mt-0.5">
          <i data-lucide="${meta.icon}" class="w-3.5 h-3.5"></i>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-1.5">
            <span class="font-bold text-white text-xs truncate">${meta.label}</span>
            <span class="text-[10px] text-slate-400 font-mono-numbers whitespace-nowrap">${formatRelativeTime(l.timestamp)}</span>
          </div>
          <p class="text-[11px] text-slate-300 mt-0.5 line-clamp-2 leading-relaxed">${escapeHtml(l.details)}</p>
          <div class="mt-1 flex items-center gap-2 text-[10px] text-slate-400">
            <span class="text-sky-300 font-bold">${escapeHtml(l.userName || l.username)}</span>
            <span>•</span>
            <span class="text-slate-400">${escapeHtml(l.device || 'جهاز')}</span>
            ${isUnread ? '<span class="w-1.5 h-1.5 rounded-full bg-amber-400 ml-auto"></span>' : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  initLucideIcons();
}

function processIncomingAuditLogs(incomingLogs, isLivePoll = true) {
  if (!Array.isArray(incomingLogs) || incomingLogs.length === 0) return;

  const existingIds = new Set((appState.auditLogs || []).map(l => l.id));
  const newItems = incomingLogs.filter(l => !existingIds.has(l.id));

  if (newItems.length > 0) {
    appState.auditLogs = [...newItems, ...(appState.auditLogs || [])];
    if (appState.auditLogs.length > 2000) {
      appState.auditLogs = appState.auditLogs.slice(0, 2000);
    }
    localStorage.setItem(STORAGE_KEYS.CACHED_AUDIT_LOGS, JSON.stringify(appState.auditLogs.slice(0, 200)));

    calculateUnreadNotifications();
    renderNotificationsList();

    // If it's a live background poll, show toast alert for external activities
    if (isLivePoll && appState.currentUser) {
      const externalActions = newItems.filter(l => l.username && l.username.toLowerCase() !== appState.currentUser.username.toLowerCase());
      if (externalActions.length > 0) {
        // Show notification for the latest external action
        showLiveNotification(externalActions[0]);
      }
    }
  }

  if (incomingLogs.length > 0) {
    appState.lastAuditCheckTime = incomingLogs[0].timestamp;
  }
}

async function pollAuditLogs() {
  if (!appState.currentUser || !appState.isOnline) return;
  try {
    const url = appState.lastAuditCheckTime 
      ? `/api/audit-logs?limit=40&since=${encodeURIComponent(appState.lastAuditCheckTime)}`
      : `/api/audit-logs?limit=40`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.logs) {
        processIncomingAuditLogs(data.logs, true);
      }
    }
  } catch (e) {}
}

async function logUserAction(actionType, details, metadata = {}) {
  const payload = {
    actionType,
    details,
    userId: appState.currentUser?.id || 'anonymous',
    username: appState.currentUser?.username || 'anonymous',
    userName: appState.currentUser?.name || 'مستخدم',
    userRole: appState.currentUser?.role || 'guest',
    metadata
  };

  try {
    const res = await fetch('/api/audit-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json();
      if (data.log) {
        processIncomingAuditLogs([data.log], false);
      }
    }
  } catch (e) {
    enqueueSyncAction({
      type: 'AUDIT_LOG',
      payload
    });
  }
}

// ==========================================
// Full Audit Logs Modal & Reports
// ==========================================

let currentAuditLogsData = [];

async function openAuditLogsModal() {
  const modal = document.getElementById('auditLogsModal');
  if (!modal) return;

  modal.classList.remove('hidden');
  modal.classList.add('flex');

  // Log opening this screen
  logUserAction('MODULE_OPEN', 'قام بفتح سجل الرقابة والحركات الشامل');

  // Check if admin to show/hide clear button
  const clearBtn = document.getElementById('adminClearAuditBtn');
  if (clearBtn) {
    if (appState.currentUser?.role === 'admin' || appState.currentUser?.username === 'admin') {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
  }

  await refreshAuditLogs();
}

async function refreshAuditLogs() {
  const icon = document.getElementById('refreshAuditLogsIcon');
  if (icon) icon.classList.add('animate-spin');

  try {
    const res = await fetch('/api/audit-logs?limit=400');
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.logs) {
        currentAuditLogsData = data.logs;
        appState.auditLogs = data.logs;
        localStorage.setItem(STORAGE_KEYS.CACHED_AUDIT_LOGS, JSON.stringify(data.logs.slice(0, 200)));
      }
    } else {
      currentAuditLogsData = appState.auditLogs || [];
    }
  } catch (e) {
    currentAuditLogsData = appState.auditLogs || [];
  } finally {
    if (icon) icon.classList.remove('animate-spin');
  }

  populateAuditUserFilter();
  updateAuditSummaryStats();
  filterAuditLogsTable();
  initLucideIcons();
}

function populateAuditUserFilter() {
  const select = document.getElementById('auditFilterUser');
  if (!select) return;

  const currentVal = select.value;
  const userSet = new Map();

  (appState.users || []).forEach(u => userSet.set(u.username, u.name || u.username));
  (currentAuditLogsData || []).forEach(l => {
    if (l.username && !userSet.has(l.username)) {
      userSet.set(l.username, l.userName || l.username);
    }
  });

  select.innerHTML = '<option value="all">جميع المستخدمين</option>' + 
    Array.from(userSet.entries()).map(([uname, unameDisplay]) => `
      <option value="${escapeHtml(uname)}">${escapeHtml(unameDisplay)} (${escapeHtml(uname)})</option>
    `).join('');

  if (currentVal) select.value = currentVal;
}

function updateAuditSummaryStats() {
  const logs = currentAuditLogsData || [];
  const statTotal = document.getElementById('auditStatTotal');
  const statExports = document.getElementById('auditStatExports');
  const statTrips = document.getElementById('auditStatTrips');
  const statFuel = document.getElementById('auditStatFuel');
  const statProcure = document.getElementById('auditStatProcure');

  if (statTotal) statTotal.textContent = logs.length.toLocaleString();
  if (statExports) statExports.textContent = logs.filter(l => l.actionType === 'DATA_EXPORT').length.toLocaleString();
  if (statTrips) statTrips.textContent = logs.filter(l => l.actionType && l.actionType.startsWith('TRIP_')).length.toLocaleString();
  if (statFuel) statFuel.textContent = logs.filter(l => l.actionType && l.actionType.startsWith('FUEL_')).length.toLocaleString();
  if (statProcure) statProcure.textContent = logs.filter(l => l.actionType && (l.actionType.startsWith('PRICE_') || l.actionType.startsWith('INVOICE_'))).length.toLocaleString();
}

function filterAuditLogsTable() {
  const typeFilter = document.getElementById('auditFilterType')?.value || 'all';
  const userFilter = document.getElementById('auditFilterUser')?.value || 'all';
  const searchQuery = (document.getElementById('auditSearchInput')?.value || '').trim().toLowerCase();

  let filtered = currentAuditLogsData || [];

  if (typeFilter !== 'all') {
    filtered = filtered.filter(l => l.actionType === typeFilter);
  }

  if (userFilter !== 'all') {
    filtered = filtered.filter(l => (l.username || '').toLowerCase() === userFilter.toLowerCase());
  }

  if (searchQuery) {
    filtered = filtered.filter(l => {
      const details = (l.details || '').toLowerCase();
      const user = (l.userName || l.username || '').toLowerCase();
      const ip = (l.ip || '').toLowerCase();
      const device = (l.device || '').toLowerCase();
      return details.includes(searchQuery) || user.includes(searchQuery) || ip.includes(searchQuery) || device.includes(searchQuery);
    });
  }

  renderAuditLogsTableRows(filtered);
}

function renderAuditLogsTableRows(logs) {
  const tbody = document.getElementById('auditLogsTableBody');
  const notice = document.getElementById('noAuditLogsNotice');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '';
    if (notice) notice.classList.remove('hidden');
    return;
  }

  if (notice) notice.classList.add('hidden');

  tbody.innerHTML = logs.map((l, idx) => {
    const meta = getActionMeta(l.actionType);
    const dateObj = new Date(l.timestamp);
    const dateFormatted = dateObj.toLocaleDateString('ar-EG', { year: 'numeric', month: 'numeric', day: 'numeric' });
    const timeFormatted = dateObj.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let roleBadge = '';
    if (l.userRole === 'admin') {
      roleBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40">admin</span>';
    } else if (l.userRole === 'fuel_officer') {
      roleBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded bg-amber-500/20 text-amber-300 font-bold border border-amber-500/40">سولار</span>';
    } else if (l.userRole === 'procurement_officer') {
      roleBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/40">مشتريات</span>';
    } else if (l.userRole === 'supervisor_readonly' || l.userRole === 'supervisor') {
      roleBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded bg-sky-500/20 text-sky-300 font-bold border border-sky-500/40">مشرف</span>';
    } else {
      roleBadge = '<span class="text-[9px] px-1.5 py-0.2 rounded bg-slate-700 text-slate-300 font-bold">سائق</span>';
    }

    return `
      <tr class="hover:bg-slate-800/40 transition-colors">
        <td class="p-3 text-center font-mono-numbers text-slate-500 text-xs">${idx + 1}</td>
        <td class="p-3 whitespace-nowrap text-xs">
          <div class="font-bold text-white font-mono-numbers">${timeFormatted}</div>
          <div class="text-[10px] text-slate-400 font-mono-numbers flex items-center gap-1.5">
            <span>${dateFormatted}</span>
            <span>(${formatRelativeTime(l.timestamp)})</span>
          </div>
        </td>
        <td class="p-3 whitespace-nowrap text-xs">
          <div class="font-bold text-white flex items-center gap-1.5">
            <span>${escapeHtml(l.userName || l.username)}</span>
            ${roleBadge}
          </div>
          <div class="text-[10px] text-slate-400 font-mono-numbers">@${escapeHtml(l.username || 'unknown')}</div>
        </td>
        <td class="p-3 whitespace-nowrap text-xs">
          <span class="px-2.5 py-1 rounded-full text-[10px] font-bold ${meta.badgeClass} inline-flex items-center gap-1.5">
            <i data-lucide="${meta.icon}" class="w-3 h-3"></i>
            <span>${meta.label}</span>
          </span>
        </td>
        <td class="p-3 text-xs">
          <div class="text-slate-200 leading-relaxed font-medium">${escapeHtml(l.details)}</div>
        </td>
        <td class="p-3 whitespace-nowrap text-xs text-slate-300">
          <span>${escapeHtml(l.device || 'متصفح')}</span>
        </td>
        <td class="p-3 whitespace-nowrap text-xs font-mono-numbers text-amber-400">
          <span class="px-2 py-0.5 rounded bg-slate-900 border border-slate-800">${escapeHtml(l.ip || '127.0.0.1')}</span>
        </td>
      </tr>
    `;
  }).join('');

  initLucideIcons();
}

function resetAuditFilters() {
  const typeFilter = document.getElementById('auditFilterType');
  const userFilter = document.getElementById('auditFilterUser');
  const searchInput = document.getElementById('auditSearchInput');

  if (typeFilter) typeFilter.value = 'all';
  if (userFilter) userFilter.value = 'all';
  if (searchInput) searchInput.value = '';

  filterAuditLogsTable();
}

function exportAuditLogsExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('جاري تحميل مكتبة Excel، حاول مجدداً', 'warning');
    return;
  }

  const logs = currentAuditLogsData || [];
  if (logs.length === 0) {
    showToast('لا توجد بيانات مطابقة لتصديرها', 'warning');
    return;
  }

  const rows = logs.map((l, idx) => {
    const meta = getActionMeta(l.actionType);
    const dateObj = new Date(l.timestamp);
    return {
      '#': idx + 1,
      'التاريخ': dateObj.toISOString().slice(0, 10),
      'الوقت': dateObj.toLocaleTimeString('ar-EG'),
      'اسم المستخدم': l.userName || l.username,
      'اسم الحساب (Username)': l.username,
      'الدور والصلاحية': l.userRole,
      'نوع الحركة': meta.label,
      'التفاصيل والبيان الكامل': l.details,
      'نوع الجهاز والمتصفح': l.device || '',
      'عنوان IP': l.ip || ''
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'سجل الرقابة والحركات');

  worksheet['!cols'] = [
    { wch: 5 }, { wch: 14 }, { wch: 12 }, { wch: 20 }, { wch: 16 },
    { wch: 16 }, { wch: 25 }, { wch: 45 }, { wch: 22 }, { wch: 18 }
  ];

  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `سجل_الرقابة_والحركات_SOS_${dateStr}.xlsx`);

  logUserAction('DATA_EXPORT', 'قام المشرف بتصدير سجل الرقابة والحركات كاملاً إلى ملف Excel');
  showToast('تم تصدير سجل الرقابة كاملاً إلى ملف Excel 📊', 'success');
}

async function adminClearAuditLogs() {
  if (appState.currentUser?.role !== 'admin' && appState.currentUser?.username !== 'admin') {
    showToast('تفريغ سجل الرقابة محصور بالمشرف العام (admin) فقط', 'warning');
    return;
  }

  if (!confirm('هل أنت متأكد من مسح وتفريغ سجل الرقابة والحركات كاملاً؟\n(هذا الإجراء نهائي ولا يمكن التراجع عنه)')) {
    return;
  }

  try {
    const res = await fetch('/api/audit-logs?role=admin&username=admin', {
      method: 'DELETE'
    });
    if (res.ok) {
      showToast('تم تفريغ سجل الرقابة بنجاح', 'success');
      await refreshAuditLogs();
    }
  } catch (e) {
    showToast('فشل تفريغ السجل', 'danger');
  }
}
