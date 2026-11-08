const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

// ==========================================
// Central Database Handler
// ==========================================

let db = {
  users: [],
  teams: [
    'فريق يونيسف (UNICEF)',
    'فريق DRA',
    'فريق FS',
    'فريق HA',
    'إداري'
  ],
  vehicles: [],
  trips: [],
  fuelLogs: [],
  purchases: [],
  auditLogs: [],
  settings: {
    appName: 'قرى الأطفال SOS للسائقين'
  }
};

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      db = JSON.parse(raw);
      if (!db.vehicles) db.vehicles = [];
      if (!db.fuelLogs) db.fuelLogs = [];
      if (!db.purchases) db.purchases = [];
      if (!db.auditLogs) db.auditLogs = [];

      // Ensure supervisor account exists (strictly readonly for user management)
      if (!db.users.some(u => u.username === 'supervisor')) {
        db.users.push({
          id: 'usr_supervisor',
          username: 'supervisor',
          password: '123',
          name: 'مسؤول السائقين',
          role: 'supervisor_readonly',
          permissions: {
            canViewTrips: true,
            canEditTrips: false,
            canDeleteTrips: false,
            canManageVehicles: false,
            canManageDrivers: false,
            canManageUsers: false,
            canExportExcel: true
          },
          phone: '0599000222',
          active: true,
          createdAt: new Date().toISOString()
        });
        saveDatabase();
      }

      // Ensure fuel officer account exists (strictly readonly for user management)
      if (!db.users.some(u => u.username === 'fuel')) {
        db.users.push({
          id: 'usr_fuel_officer',
          username: 'fuel',
          password: '123',
          name: 'مسؤول السولار والوقود',
          role: 'fuel_officer',
          permissions: {
            canViewTrips: false,
            canEditTrips: false,
            canDeleteTrips: false,
            canManageVehicles: false,
            canManageDrivers: false,
            canManageUsers: false,
            canExportExcel: false
          },
          phone: '0599000333',
          active: true,
          createdAt: new Date().toISOString()
        });
        saveDatabase();
      }

      if (!db.purchases) db.purchases = [];

      // Ensure procurement officer account exists (المشتريات وجرد المركبات)
      if (!db.users.some(u => u.username === 'procurement')) {
        db.users.push({
          id: 'usr_procurement',
          username: 'procurement',
          password: '123',
          name: 'مسؤول المشتريات',
          role: 'procurement_officer',
          permissions: {
            canViewTrips: false,
            canEditTrips: false,
            canDeleteTrips: false,
            canManageVehicles: true,
            canManageDrivers: false,
            canManageUsers: false,
            canExportExcel: true
          },
          phone: '0599000444',
          active: true,
          createdAt: new Date().toISOString()
        });
        saveDatabase();
      }

      // Ensure vehicles have dailyRentalRate, purchasePrice and modelYear
      if (db.vehicles) {
        db.vehicles.forEach(v => {
          if (v.dailyRentalRate === undefined) {
            if (v.name.includes('توسان') || v.name.includes('هايلوكس')) v.dailyRentalRate = 250;
            else v.dailyRentalRate = 200;
          }
          if (v.purchasePrice === undefined) {
            if (v.name.includes('توسان')) v.purchasePrice = 115000;
            else if (v.name.includes('هايلوكس')) v.purchasePrice = 135000;
            else if (v.name.includes('اسكودا')) v.purchasePrice = 85000;
            else v.purchasePrice = 75000;
          }
          if (v.modelYear === undefined) v.modelYear = '2021';
        });
        recalculateVehiclePurchases();
      }

      console.log(`[DB] تم تحميل قاعدة البيانات بنجاح: ${db.users.length} مستخدم، ${db.vehicles.length} مركبة، ${db.trips.length} رحلة، ${(db.fuelLogs || []).length} تعبئة سولار، ${(db.purchases || []).length} فاتورة مشتريات.`);
    } else {
      saveDatabase();
    }
  } catch (err) {
    console.error('[DB] خطأ في قراءة ملف قاعدة البيانات:', err);
  }
}

function saveDatabase() {
  try {
    const dir = path.dirname(DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DB] فشل حفظ قاعدة البيانات:', err);
  }
}

function recalculateVehiclePurchases() {
  if (!db || !db.vehicles) return;
  const purchases = db.purchases || [];
  db.vehicles.forEach(v => {
    const total = purchases
      .filter(p => p.vehicleName && p.vehicleName.toLowerCase() === v.name.toLowerCase())
      .reduce((acc, p) => acc + (Number(p.cost) || 0), 0);
    v.totalPurchasesCost = total;
  });
}

// ==========================================
// Audit Trail & Activity Logger (سجل الرقابة ونظام الإشعارات)
// ==========================================

function getClientIp(req) {
  if (!req) return '127.0.0.1';
  const forwarded = req.headers ? req.headers['x-forwarded-for'] : null;
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  let ip = req.socket?.remoteAddress || '127.0.0.1';
  if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

function detectClientDevice(userAgent) {
  if (!userAgent) return 'جهاز محلي';
  const ua = userAgent.toLowerCase();
  if (ua.includes('android')) return '📱 هاتف أندرويد';
  if (ua.includes('iphone')) return '📱 هاتف آيفون';
  if (ua.includes('ipad')) return '📱 جهاز آيباد';
  if (ua.includes('mobile')) return '📱 جهاز محمول';
  if (ua.includes('windows')) return '💻 كمبيوتر (Windows)';
  if (ua.includes('macintosh') || ua.includes('mac os')) return '💻 كمبيوتر (Mac)';
  if (ua.includes('linux')) return '💻 كمبيوتر (Linux)';
  return '🌐 متصفح ويب';
}

function addAuditLogEntry({ userId, username, userName, userRole, actionType, details, metadata, req }) {
  try {
    if (!db.auditLogs) db.auditLogs = [];
    const ip = getClientIp(req);
    const userAgent = req?.headers ? req.headers['user-agent'] : '';
    const device = detectClientDevice(userAgent);

    const entry = {
      id: 'audit_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      userId: userId || 'anonymous',
      username: username || 'anonymous',
      userName: userName || username || 'مستخدم',
      userRole: userRole || 'user',
      actionType: actionType || 'GENERAL_ACTION',
      details: details || '',
      metadata: metadata || {},
      ip,
      device
    };

    db.auditLogs.unshift(entry);
    // Keep last 2,000 entries
    if (db.auditLogs.length > 2000) {
      db.auditLogs = db.auditLogs.slice(0, 2000);
    }
    saveDatabase();
    console.log(`[AUDIT] [${entry.actionType}] ${entry.userName} (${entry.username}): ${entry.details} [${entry.device} - ${entry.ip}]`);
    return entry;
  } catch (err) {
    console.error('[AUDIT] خطأ في حفظ سجل الرقابة:', err);
    return null;
  }
}

// =========================================================================
// احتساب إيجار السيارات باليوم على الفرق:
// "تسعيرة اجار باليوم يتم احتساب السيارة ع كل فريق لحاله بحيث اول طلعة لسيارة
// يتم احتسابها فقط باقي اليوم ما يتم حسابه ولكن تسجيل الرحلات"
// =========================================================================

function computeFleetRentalAccounts(trips, vehicles, teams, purchases) {
  const vehicleDateTrips = new Map();

  (trips || []).forEach(t => {
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

  const tripBillingMap = new Map();
  const vehicleBillingDays = new Map();
  const teamBillingDays = new Map();

  (teams || []).forEach(team => {
    teamBillingDays.set(team, []);
  });

  for (const [key, vTrips] of vehicleDateTrips.entries()) {
    const [vehicleName, dateStr] = key.split(':::');
    const veh = (vehicles || []).find(v => v.name === vehicleName) || { dailyRentalRate: 200 };
    const dailyRate = Number(veh.dailyRentalRate) || 200;

    // Chronological sort to identify the FIRST trip of the calendar day
    vTrips.sort((a, b) => {
      const timeA = new Date(a.startDateTime || a.startTime || a.createdAt).getTime();
      const timeB = new Date(b.startDateTime || b.startTime || b.createdAt).getTime();
      return timeA - timeB;
    });

    const firstTrip = vTrips[0];
    const billedTeam = firstTrip.team || 'غير محدد';

    // First trip of the day gets the full daily rental charge!
    tripBillingMap.set(firstTrip.id, {
      isFirstTripOfDay: true,
      billedTeam: billedTeam,
      rentalAmount: dailyRate,
      dateStr,
      vehicleName,
      driverName: firstTrip.driverName || '',
      tripDestination: firstTrip.destination || ''
    });

    // Subsequent trips on the same day for this car are charged 0 NIS (covered by first trip)
    for (let i = 1; i < vTrips.length; i++) {
      tripBillingMap.set(vTrips[i].id, {
        isFirstTripOfDay: false,
        billedTeam: billedTeam,
        rentalAmount: 0,
        dateStr,
        vehicleName,
        driverName: vTrips[i].driverName || '',
        tripDestination: vTrips[i].destination || '',
        note: `الإيجار اليومي (${dailyRate} ₪) محسوب على أول طلعة مع: ${billedTeam}`
      });
    }

    if (!vehicleBillingDays.has(vehicleName)) {
      vehicleBillingDays.set(vehicleName, []);
    }
    vehicleBillingDays.get(vehicleName).push({
      dateStr,
      firstTripId: firstTrip.id,
      billedTeam,
      rentalRate: dailyRate,
      driverName: firstTrip.driverName || '',
      tripDestination: firstTrip.destination || ''
    });

    if (!teamBillingDays.has(billedTeam)) {
      teamBillingDays.set(billedTeam, []);
    }
    teamBillingDays.get(billedTeam).push({
      dateStr,
      vehicleName,
      rentalRate: dailyRate,
      tripId: firstTrip.id,
      driverName: firstTrip.driverName || '',
      tripDestination: firstTrip.destination || ''
    });
  }

  const teamAccounts = {};
  let totalBilledDays = 0;
  let totalRentalCost = 0;

  for (const [teamName, days] of teamBillingDays.entries()) {
    const teamTrips = (trips || []).filter(t => t.team === teamName);
    const teamRentalCost = days.reduce((sum, d) => sum + d.rentalRate, 0);
    teamAccounts[teamName] = {
      teamName,
      billedDaysCount: days.length,
      totalRentalCost: teamRentalCost,
      totalTripsCount: teamTrips.length,
      daysLog: days.sort((a, b) => b.dateStr.localeCompare(a.dateStr))
    };
    totalBilledDays += days.length;
    totalRentalCost += teamRentalCost;
  }

  const vehicleAccounts = {};
  (vehicles || []).forEach(v => {
    const days = vehicleBillingDays.get(v.name) || [];
    const vPurchases = (purchases || []).filter(p => p.vehicleName === v.name);
    const purchasesCost = vPurchases.reduce((sum, p) => sum + (Number(p.cost) || 0), 0);
    const rentalTotal = days.reduce((sum, d) => sum + d.rentalRate, 0);
    const dailyRate = Number(v.dailyRentalRate) || 200;

    vehicleAccounts[v.name] = {
      vehicleId: v.id,
      vehicleName: v.name,
      plateNumber: v.plateNumber || '-',
      driverName: v.driverName || 'غير معين',
      dailyRentalRate: dailyRate,
      billedDaysCount: days.length,
      totalRentalAmount: rentalTotal,
      purchasesCost: purchasesCost,
      grandTotal: rentalTotal + purchasesCost,
      daysLog: days.sort((a, b) => b.dateStr.localeCompare(a.dateStr))
    };
  });

  const totalPurchasesCost = (purchases || []).reduce((sum, p) => sum + (Number(p.cost) || 0), 0);

  return {
    teamAccounts,
    vehicleAccounts,
    grandTotals: {
      totalBilledDays,
      totalRentalCost,
      totalPurchasesCost,
      grandTotal: totalRentalCost + totalPurchasesCost
    },
    tripBillingMap: Object.fromEntries(tripBillingMap.entries())
  };
}

// Initial DB Load
loadDatabase();

// ==========================================
// HTTP Helpers
// ==========================================

function sendJson(res, statusCode, data) {
  const payload = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(payload);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ==========================================
// Main HTTP Server
// ==========================================

const server = http.createServer(async (req, res) => {
  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // ==========================================
  // REST API Endpoints (/api/...)
  // ==========================================

  if (pathname.startsWith('/api/')) {
    try {
      // 1. Status Check
      if (pathname === '/api/status' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          appName: 'قرى الأطفال SOS للسائقين',
          usersCount: db.users.length,
          vehiclesCount: (db.vehicles || []).length,
          tripsCount: db.trips.length,
          serverTime: new Date().toISOString()
        });
      }

      // 2. Bootstrap (Initial Full Sync for client)
      if (pathname === '/api/bootstrap' && method === 'GET') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        const isSupervisorOrDriver = queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryRole === 'driver' || queryUser === 'supervisor';

        let safeVehicles = db.vehicles || [];
        let safeFuelLogs = db.fuelLogs || [];
        let safePurchases = db.purchases || [];
        let safeRentalAccounts = computeFleetRentalAccounts(db.trips, db.vehicles, db.teams, db.purchases);
        let safeTrips = db.trips || [];

        // STRICT RULE: ما بدي مسؤول السواقين يعرف السعر أو فواتير المشتريات
        if (isSupervisorOrDriver) {
          safePurchases = [];
          safeRentalAccounts = null;
          safeVehicles = safeVehicles.map(v => {
            const copy = { ...v };
            delete copy.dailyRentalRate;
            delete copy.purchasePrice;
            delete copy.rentalNotes;
            delete copy.purchaseNotes;
            return copy;
          });
          safeFuelLogs = safeFuelLogs.map(f => {
            const copy = { ...f };
            delete copy.cost;
            delete copy.totalCost;
            delete copy.pricePerLiter;
            return copy;
          });
          safeTrips = safeTrips.map(t => {
            const copy = { ...t };
            delete copy.rentalRateCharged;
            if (copy.fuel) {
              const fCopy = { ...copy.fuel };
              delete fCopy.cost;
              copy.fuel = fCopy;
            }
            return copy;
          });
        }

        return sendJson(res, 200, {
          success: true,
          users: db.users.map(u => ({
            id: u.id,
            username: u.username,
            name: u.name,
            role: u.role || 'driver',
            permissions: u.permissions || null,
            phone: u.phone,
            vehicle: u.vehicle,
            active: u.active !== false
          })),
          vehicles: safeVehicles,
          teams: db.teams,
          trips: safeTrips,
          fuelLogs: safeFuelLogs,
          purchases: safePurchases,
          auditLogs: (db.auditLogs || []).slice(0, 60),
          rentalAccounts: safeRentalAccounts,
          settings: db.settings
        });
      }

      // 3. User Login
      if (pathname === '/api/auth/login' && method === 'POST') {
        const { username, password } = await parseJsonBody(req);
        if (!username || !password) {
          return sendJson(res, 400, { success: false, error: 'يرجى إدخال اسم المستخدم وكلمة المرور' });
        }

        let queryUser = username.trim().toLowerCase();
        // Support convenient Arabic & English aliases
        if (queryUser === 'مشتريات' || queryUser === 'المشتريات' || queryUser === 'purchases' || queryUser === 'مسؤول المشتريات') {
          queryUser = 'procurement';
        } else if (queryUser === 'سولار' || queryUser === 'السولار' || queryUser === 'وقود' || queryUser === 'الوقود' || queryUser === 'مسؤول السولار') {
          queryUser = 'fuel';
        } else if (queryUser === 'مشرف' || queryUser === 'المشرف' || queryUser === 'مسؤول السائقين') {
          queryUser = 'supervisor';
        } else if (queryUser === 'ادمن' || queryUser === 'الادمن' || queryUser === 'المشرف العام') {
          queryUser = 'admin';
        }

        const inputPassword = password.trim();
        const user = db.users.find(u => {
          const matchUser = (u.username.toLowerCase() === queryUser || (u.phone && u.phone.trim() === queryUser));
          if (!matchUser) return false;
          // For admin, accept both admin123 and 123
          if (u.username.toLowerCase() === 'admin' && (inputPassword === '123' || inputPassword === 'admin123')) {
            return true;
          }
          return u.password === inputPassword;
        });

        if (!user) {
          addAuditLogEntry({
            userId: 'guest',
            username: queryUser,
            userName: queryUser,
            userRole: 'guest',
            actionType: 'LOGIN_FAILED',
            details: `محاولة تسجيل دخول فاشلة باسم المستخدم: "${queryUser}"`,
            req
          });
          return sendJson(res, 401, { success: false, error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }

        if (user.active === false) {
          return sendJson(res, 403, { success: false, error: 'هذا الحساب معطل حالياً من قِبل المشرف' });
        }

        addAuditLogEntry({
          userId: user.id,
          username: user.username,
          userName: user.name,
          userRole: user.role || 'driver',
          actionType: 'LOGIN',
          details: `تسجيل دخول ناجح للمستخدم (${user.name}) بدور: ${user.role || 'سائق'}`,
          metadata: { vehicle: user.vehicle, phone: user.phone },
          req
        });

        return sendJson(res, 200, {
          success: true,
          user: {
            id: user.id,
            username: user.username,
            name: user.name,
            role: user.role || 'driver',
            permissions: user.permissions || null,
            phone: user.phone,
            vehicle: user.vehicle
          }
        });
      }

      // 4. Forgot Password / Reset
      if (pathname === '/api/auth/forgot-password' && method === 'POST') {
        const { usernameOrPhone, newPassword } = await parseJsonBody(req);
        if (!usernameOrPhone || !newPassword) {
          return sendJson(res, 400, { success: false, error: 'يرجى تقديم اسم المستخدم أو رقم الهاتف وكلمة المرور الجديدة' });
        }

        const query = usernameOrPhone.trim().toLowerCase();
        const user = db.users.find(u => 
          u.username.toLowerCase() === query || (u.phone && u.phone.trim() === query)
        );

        if (!user) {
          return sendJson(res, 404, { success: false, error: 'لم يتم العثور على حساب مطابق لهذا الاسم أو رقم الهاتف' });
        }

        user.password = newPassword.trim();
        saveDatabase();

        return sendJson(res, 200, {
          success: true,
          message: `تم تحديث كلمة المرور للمستخدم (${user.name}) بنجاح.`
        });
      }

      // 5. Get Users List (Admin)
      if (pathname === '/api/users' && method === 'GET') {
        return sendJson(res, 200, {
          success: true,
          users: db.users
        });
      }

      // 6. Add New User / Driver / Administrative Account (Admin ONLY)
      if (pathname === '/api/users' && method === 'POST') {
        const body = await parseJsonBody(req);
        const { name, username, password, vehicle, phone, role, permissions, requesterRole, requesterUsername } = body;

        const reqRole = requesterRole || body.requesterRole || parsedUrl.searchParams.get('role');
        const reqUser = requesterUsername || body.requesterUsername || parsedUrl.searchParams.get('username');
        const userRole = role || 'driver';

        // Admin can add any user/role. Adding a driver is always allowed from the app.
        const isAllowed = reqRole === 'admin' || reqUser === 'admin' || userRole === 'driver' || !reqRole;
        if (!isAllowed) {
          return sendJson(res, 403, { success: false, error: 'عذراً، إدارة وإنشاء المستخدمين وتحديد الصلاحيات محصورة بحساب المشرف العام (admin) فقط' });
        }

        if (!name || !username || !password) {
          return sendJson(res, 400, { success: false, error: 'الاسم واسم المستخدم وكلمة المرور مطلوبة' });
        }

        const cleanUsername = username.trim().toLowerCase();
        if (db.users.some(u => u.username.toLowerCase() === cleanUsername)) {
          return sendJson(res, 400, { success: false, error: 'اسم المستخدم مسجل مسبقاً، يرجى اختيار اسم آخر' });
        }

        let userPerms = permissions || null;

        // Default permissions based on role
        if (!userPerms) {
          if (userRole === 'admin') {
            userPerms = {
              canViewTrips: true,
              canEditTrips: true,
              canDeleteTrips: true,
              canManageVehicles: true,
              canManageDrivers: true,
              canManageUsers: true,
              canExportExcel: true
            };
          } else if (userRole === 'supervisor_readonly') {
            userPerms = {
              canViewTrips: true,
              canEditTrips: false,
              canDeleteTrips: false,
              canManageVehicles: false,
              canManageDrivers: false,
              canManageUsers: false,
              canExportExcel: true
            };
          }
        }

        const newUser = {
          id: 'usr_' + Date.now(),
          username: cleanUsername,
          password: password.trim(),
          name: name.trim(),
          role: userRole,
          permissions: userPerms,
          vehicle: (vehicle || '').trim(),
          phone: (phone || '').trim(),
          active: true,
          createdAt: new Date().toISOString()
        };

        db.users.push(newUser);

        // If it's a driver and has vehicle, check if vehicle should be in fleet
        if (userRole === 'driver' && newUser.vehicle) {
          const vExists = (db.vehicles || []).some(v => v.name.toLowerCase() === newUser.vehicle.toLowerCase());
          if (!vExists) {
            if (!db.vehicles) db.vehicles = [];
            db.vehicles.push({
              id: 'veh_' + Date.now(),
              name: newUser.vehicle,
              plateNumber: '-',
              driverUsername: newUser.username,
              driverName: newUser.name,
              currentOdometer: 0,
              fuelCapacityLiters: 60,
              currentFuelLiters: 40,
              status: 'active',
              lastUpdated: new Date().toISOString()
            });
          }
        }

        saveDatabase();

        addAuditLogEntry({
          userId: reqUser || 'admin',
          username: reqUser || 'admin',
          userName: 'المشرف العام',
          userRole: 'admin',
          actionType: 'USER_CREATE',
          details: `إنشاء حساب جديد: "${newUser.name}" (${newUser.username}) [الدور: ${newUser.role}]`,
          metadata: { userId: newUser.id, role: newUser.role, vehicle: newUser.vehicle },
          req
        });

        console.log(`[DB] تم إنشاء حساب جديد: ${newUser.name} (${newUser.username}) [الدور: ${newUser.role}]`);
        return sendJson(res, 201, { success: true, user: newUser });
      }

      // 7. Update User / Driver / Admin Permissions (Admin ONLY)
      if (pathname.startsWith('/api/users/') && method === 'PUT') {
        const userId = pathname.replace('/api/users/', '');
        const body = await parseJsonBody(req);

        const reqRole = body.requesterRole || parsedUrl.searchParams.get('role');
        const reqUser = body.requesterUsername || parsedUrl.searchParams.get('username');

        // Allow update if admin or if resetting password or default app action
        const isAllowed = reqRole === 'admin' || reqUser === 'admin' || body.password || !reqRole;
        if (!isAllowed) {
          return sendJson(res, 403, { success: false, error: 'عذراً، تعديل المستخدمين وتغيير الصلاحيات محصور بحساب المشرف العام (admin) فقط' });
        }

        const user = db.users.find(u => u.id === userId);

        if (!user) {
          return sendJson(res, 404, { success: false, error: 'المستخدم غير موجود' });
        }

        if (body.name) user.name = body.name.trim();
        if (body.vehicle !== undefined) user.vehicle = body.vehicle.trim();
        if (body.phone !== undefined) user.phone = body.phone.trim();
        if (body.password) user.password = body.password.trim();
        if (body.role) user.role = body.role;
        if (body.permissions !== undefined) user.permissions = body.permissions;
        if (body.active !== undefined) user.active = Boolean(body.active);

        saveDatabase();

        addAuditLogEntry({
          userId: reqUser || 'admin',
          username: reqUser || 'admin',
          userName: 'المشرف العام',
          userRole: 'admin',
          actionType: body.password ? 'PASSWORD_RESET' : 'USER_UPDATE',
          details: body.password ? `إعادة تعيين كلمة مرور المستخدم (${user.name})` : `تحديث بيانات وصلاحيات المستخدم (${user.name})`,
          metadata: { targetUserId: user.id, targetUsername: user.username },
          req
        });

        return sendJson(res, 200, { success: true, user });
      }

      // 8. Delete User (Admin ONLY)
      if (pathname.startsWith('/api/users/') && method === 'DELETE') {
        const userId = pathname.replace('/api/users/', '');
        const queryRole = parsedUrl.searchParams.get('role');
        const queryUser = parsedUrl.searchParams.get('username');

        // Allow deletion by admin (or default app context)
        const isAllowed = queryRole === 'admin' || queryUser === 'admin' || !queryRole;
        if (!isAllowed) {
          return sendJson(res, 403, { success: false, error: 'عذراً، حذف المستخدمين محصور بحساب المشرف العام (admin) فقط' });
        }

        const index = db.users.findIndex(u => u.id === userId);

        if (index === -1) {
          return sendJson(res, 404, { success: false, error: 'المستخدم غير موجود' });
        }

        if (db.users[index].username === 'admin') {
          return sendJson(res, 400, { success: false, error: 'لا يمكن حذف حساب المشرف العام الرئيسي' });
        }

        const deleted = db.users.splice(index, 1)[0];
        saveDatabase();

        addAuditLogEntry({
          userId: queryUser || 'admin',
          username: queryUser || 'admin',
          userName: 'المشرف العام',
          userRole: 'admin',
          actionType: 'USER_DELETE',
          details: `حذف حساب المستخدم نهائياً: "${deleted.name}" (${deleted.username})`,
          metadata: { deletedUserId: deleted.id, deletedUsername: deleted.username },
          req
        });

        console.log(`[DB] تم حذف الحساب: ${deleted.name}`);
        return sendJson(res, 200, { success: true, deletedId: userId });
      }

      // 9. Vehicles & Fuel Management
      if (pathname === '/api/vehicles' && method === 'GET') {
        return sendJson(res, 200, { success: true, vehicles: db.vehicles || [] });
      }

      if (pathname === '/api/vehicles' && method === 'POST') {
        const vData = await parseJsonBody(req);
        if (!vData.name) {
          return sendJson(res, 400, { success: false, error: 'اسم المركبة مطلوب' });
        }

        const newVeh = {
          id: 'veh_' + Date.now(),
          name: vData.name.trim(),
          plateNumber: (vData.plateNumber || '').trim(),
          driverUsername: (vData.driverUsername || '').trim(),
          driverName: (vData.driverName || '').trim(),
          currentOdometer: Number(vData.currentOdometer) || 0,
          fuelCapacityLiters: Number(vData.fuelCapacityLiters) || 60,
          currentFuelLiters: Number(vData.currentFuelLiters) || 0,
          dailyRentalRate: Number(vData.dailyRentalRate) || 200,
          purchasePrice: Number(vData.dailyRentalRate) || 200,
          fuelType: vData.fuelType || 'بنزين',
          status: vData.status || 'active',
          lastUpdated: new Date().toISOString()
        };

        if (!db.vehicles) db.vehicles = [];
        db.vehicles.push(newVeh);
        saveDatabase();

        addAuditLogEntry({
          userId: vData.recordedBy || 'admin',
          username: vData.recordedBy || 'admin',
          userName: 'المشرف',
          userRole: 'admin',
          actionType: 'VEHICLE_CREATE',
          details: `إضافة مركبة جديدة إلى الأسطول: "${newVeh.name}" (اللوحة: ${newVeh.plateNumber || '-'}) بتسعيرة إيجار: ${newVeh.dailyRentalRate} ₪/يوم`,
          req
        });

        console.log(`[DB] تم إضافة مركبة جديدة: ${newVeh.name}`);
        return sendJson(res, 201, { success: true, vehicle: newVeh });
      }

      // Fleet Rental Report ("تسعيرة اجار باليوم يتم احتساب السيارة ع كل فريق لحاله بحيث اول طلعة لسيارة يتم احتسابها فقط")
      if (pathname === '/api/fleet/rental-report' && method === 'GET') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        if (queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryUser === 'supervisor' || queryRole === 'driver') {
          return sendJson(res, 403, { success: false, error: 'غير مصرح لمسؤول السائقين أو السائق بالاطلاع على الأسعار والتقارير المالية' });
        }
        const report = computeFleetRentalAccounts(db.trips, db.vehicles, db.teams, db.purchases);
        return sendJson(res, 200, { success: true, ...report });
      }

      // Update vehicle rental rate & daily price ("تسعيرة اجار باليوم")
      if (pathname.startsWith('/api/vehicles/') && (pathname.endsWith('/price') || pathname.endsWith('/rental-rate')) && method === 'PUT') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        if (queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryUser === 'supervisor' || queryRole === 'driver') {
          return sendJson(res, 403, { success: false, error: 'تعديل تسعيرة الإيجار محصور بحساب المشرف العام (admin) أو المشتريات فقط' });
        }
        const vehicleId = pathname.replace('/api/vehicles/', '').replace('/price', '').replace('/rental-rate', '');
        const body = await parseJsonBody(req);
        const veh = (db.vehicles || []).find(v => v.id === vehicleId || v.name.toLowerCase() === vehicleId.toLowerCase());

        if (!veh) {
          return sendJson(res, 404, { success: false, error: 'المركبة غير موجودة' });
        }

        if (body.dailyRentalRate !== undefined) veh.dailyRentalRate = Number(body.dailyRentalRate);
        if (body.purchasePrice !== undefined) veh.dailyRentalRate = Number(body.purchasePrice);
        if (body.modelYear !== undefined) veh.modelYear = String(body.modelYear).trim();
        if (body.chassisNumber !== undefined) veh.chassisNumber = String(body.chassisNumber).trim();
        if (body.rentalNotes !== undefined) veh.rentalNotes = String(body.rentalNotes).trim();
        if (body.purchaseNotes !== undefined) veh.rentalNotes = String(body.purchaseNotes).trim();
        if (body.notes !== undefined) veh.rentalNotes = String(body.notes).trim();
        veh.lastUpdated = new Date().toISOString();

        saveDatabase();

        addAuditLogEntry({
          userId: body.recordedByUsername || 'admin',
          username: body.recordedByUsername || 'admin',
          userName: body.recordedByName || 'المشرف/المشتريات',
          userRole: 'admin',
          actionType: 'PRICE_UPDATE',
          details: `تعديل وضبط تسعيرة الإيجار اليومي للمركبة "${veh.name}" إلى (${veh.dailyRentalRate} ₪/يوم)`,
          metadata: { vehicleId: veh.id, newRate: veh.dailyRentalRate },
          req
        });

        console.log(`[DB] تم تحديث وضبط تسعيرة الإيجار اليومي للمركبة: ${veh.name} (${veh.dailyRentalRate} ₪/يوم)`);
        return sendJson(res, 200, { success: true, vehicle: veh });
      }

      if (pathname.startsWith('/api/vehicles/') && method === 'PUT') {
        const vId = pathname.replace('/api/vehicles/', '');
        const vData = await parseJsonBody(req);
        if (!db.vehicles) db.vehicles = [];
        const veh = db.vehicles.find(v => v.id === vId);

        if (!veh) {
          return sendJson(res, 404, { success: false, error: 'المركبة غير موجودة' });
        }

        if (vData.name !== undefined) veh.name = vData.name.trim();
        if (vData.plateNumber !== undefined) veh.plateNumber = vData.plateNumber.trim();
        if (vData.driverUsername !== undefined) veh.driverUsername = vData.driverUsername.trim();
        if (vData.driverName !== undefined) veh.driverName = vData.driverName.trim();
        if (vData.currentOdometer !== undefined) veh.currentOdometer = Number(vData.currentOdometer) || 0;
        if (vData.fuelCapacityLiters !== undefined) veh.fuelCapacityLiters = Number(vData.fuelCapacityLiters) || 60;
        if (vData.currentFuelLiters !== undefined) veh.currentFuelLiters = Number(vData.currentFuelLiters) || 0;
        if (vData.fuelType !== undefined) veh.fuelType = vData.fuelType;
        if (vData.dailyRentalRate !== undefined) {
          veh.dailyRentalRate = Number(vData.dailyRentalRate) || 200;
          veh.purchasePrice = Number(vData.dailyRentalRate) || 200;
        }
        if (vData.status !== undefined) veh.status = vData.status;
        veh.lastUpdated = new Date().toISOString();

        saveDatabase();

        addAuditLogEntry({
          userId: 'admin',
          username: 'admin',
          userName: 'المشرف',
          userRole: 'admin',
          actionType: 'VEHICLE_UPDATE',
          details: `تحديث بيانات المركبة "${veh.name}" (العداد: ${veh.currentOdometer} كم، الوقود: ${veh.currentFuelLiters} لتر)`,
          req
        });

        console.log(`[DB] تم تحديث بيانات المركبة والوقود: ${veh.name} (العداد: ${veh.currentOdometer}، الوقود: ${veh.currentFuelLiters}L)`);
        return sendJson(res, 200, { success: true, vehicle: veh });
      }

      if (pathname.startsWith('/api/vehicles/') && method === 'DELETE') {
        const vId = pathname.replace('/api/vehicles/', '');
        if (!db.vehicles) db.vehicles = [];
        const vIdx = db.vehicles.findIndex(v => v.id === vId);

        if (vIdx === -1) {
          return sendJson(res, 404, { success: false, error: 'المركبة غير موجودة' });
        }

        const del = db.vehicles.splice(vIdx, 1)[0];
        saveDatabase();

        addAuditLogEntry({
          userId: 'admin',
          username: 'admin',
          userName: 'المشرف',
          userRole: 'admin',
          actionType: 'VEHICLE_DELETE',
          details: `حذف المركبة "${del.name}" نهائياً من الأسطول`,
          req
        });

        console.log(`[DB] تم حذف المركبة: ${del.name}`);
        return sendJson(res, 200, { success: true, deletedId: vId });
      }

      // 10. Get Trips
      if (pathname === '/api/trips' && method === 'GET') {
        const driver = parsedUrl.searchParams.get('driver');
        if (driver) {
          const filtered = db.trips.filter(t => t.driverUsername === driver || t.driverName === driver);
          return sendJson(res, 200, { success: true, trips: filtered });
        }
        return sendJson(res, 200, { success: true, trips: db.trips });
      }

      // 11. Create Trip (Start Trip, Manual Entry, or Supervisor Dispatch)
      if (pathname === '/api/trips' && method === 'POST') {
        const tripData = await parseJsonBody(req);
        if (!tripData.team || (tripData.status !== 'dispatched' && tripData.startOdometer === undefined)) {
          return sendJson(res, 400, { success: false, error: 'بيانات الرحلة غير مكتملة (الفريق مطلوب)' });
        }

        const isDispatched = tripData.status === 'dispatched';
        const newTrip = {
          id: tripData.id || ('TRIP_' + Date.now()),
          driverUsername: tripData.driverUsername || 'unknown',
          driverName: tripData.driverName || 'سائق غير معروف',
          vehicle: tripData.vehicle || '',
          team: tripData.team,
          passengers: Array.isArray(tripData.passengers) ? tripData.passengers : [],
          destination: tripData.destination || '',
          startOdometer: tripData.startOdometer !== undefined && tripData.startOdometer !== null ? Number(tripData.startOdometer) : 0,
          endOdometer: tripData.endOdometer !== undefined && tripData.endOdometer !== null ? Number(tripData.endOdometer) : null,
          distanceKm: tripData.distanceKm !== undefined && tripData.distanceKm !== null ? Number(tripData.distanceKm) : null,
          startTime: tripData.startTime || new Date().toISOString(),
          endTime: tripData.endTime || null,
          startPhoto: tripData.startPhoto || null,
          endPhoto: tripData.endPhoto || null,
          fuel: tripData.fuel || null,
          notes: tripData.notes || '',
          status: isDispatched ? 'dispatched' : (tripData.endOdometer ? 'completed' : 'in_progress'),
          driverResponse: isDispatched ? (tripData.driverResponse || 'pending') : null,
          rejectionReason: tripData.rejectionReason || null,
          dispatchedAt: isDispatched ? new Date().toISOString() : null,
          createdAt: new Date().toISOString()
        };

        // If trip is completed, update vehicle odometer
        if (newTrip.endOdometer && db.vehicles) {
          const veh = db.vehicles.find(v => 
            (v.name && newTrip.vehicle && v.name.toLowerCase().includes(newTrip.vehicle.toLowerCase())) ||
            (v.driverUsername === newTrip.driverUsername)
          );
          if (veh) {
            veh.currentOdometer = Math.max(veh.currentOdometer || 0, newTrip.endOdometer);
            if (newTrip.fuel?.hasExpense && newTrip.fuel?.liters) {
              veh.currentFuelLiters = Math.min(veh.fuelCapacityLiters || 60, (veh.currentFuelLiters || 0) + Number(newTrip.fuel.liters));
            }
            veh.lastUpdated = new Date().toISOString();
          }
        }

        // Add to front of trips list
        db.trips.unshift(newTrip);
        saveDatabase();

        addAuditLogEntry({
          userId: newTrip.driverUsername,
          username: newTrip.driverUsername,
          userName: newTrip.driverName,
          userRole: 'driver',
          actionType: 'TRIP_CREATE',
          details: isDispatched 
            ? `تكليف رحلة جديدة للسائق (${newTrip.driverName}) مع (${newTrip.team}) إلى ${newTrip.destination || 'غير محدد'}`
            : `بدء رحلة جديدة بواسطة (${newTrip.driverName}) مع (${newTrip.team}) إلى ${newTrip.destination || 'غير محدد'} (العداد: ${newTrip.startOdometer} كم)`,
          metadata: { tripId: newTrip.id, vehicle: newTrip.vehicle, team: newTrip.team },
          req
        });

        console.log(`[DB] تم حفظ رحلة جديدة: ${newTrip.team} (${newTrip.status}) بواسطة ${newTrip.driverName}`);
        return sendJson(res, 201, { success: true, trip: newTrip });
      }

      // 11.1 Driver Respond to Dispatched Trip (Accept / Reject)
      if (pathname.match(/^\/api\/trips\/[^/]+\/respond$/) && method === 'POST') {
        const tripId = pathname.split('/')[3];
        const { driverResponse, rejectionReason, startOdometer } = await parseJsonBody(req);
        const trip = db.trips.find(t => t.id === tripId);

        if (!trip) {
          return sendJson(res, 404, { success: false, error: 'الرحلة غير موجودة' });
        }

        trip.driverResponse = driverResponse; // 'accepted' or 'rejected'
        if (driverResponse === 'rejected') {
          trip.status = 'rejected';
          trip.rejectionReason = rejectionReason || 'غير متاح حالياً';
        } else if (driverResponse === 'accepted') {
          trip.status = 'accepted';
          if (startOdometer !== undefined && startOdometer !== null) {
            trip.startOdometer = Number(startOdometer);
          }
        }
        trip.respondedAt = new Date().toISOString();
        saveDatabase();

        addAuditLogEntry({
          userId: trip.driverUsername,
          username: trip.driverUsername,
          userName: trip.driverName,
          userRole: 'driver',
          actionType: 'TRIP_RESPOND',
          details: driverResponse === 'accepted'
            ? `قبل السائق (${trip.driverName}) التكليف بالرحلة متوجهاً إلى (${trip.destination || ''})`
            : `اعتذر السائق (${trip.driverName}) عن قبول الرحلة. السبب: ${trip.rejectionReason}`,
          metadata: { tripId: trip.id, response: driverResponse },
          req
        });

        console.log(`[DB] رد السائق (${trip.driverName}) على الرحلة ${trip.id}: ${driverResponse}`);
        return sendJson(res, 200, { success: true, trip });
      }

      // 12. Update Trip (End Trip, or Admin Edit)
      if (pathname.startsWith('/api/trips/') && method === 'PUT') {
        const tripId = pathname.replace('/api/trips/', '');
        const updateData = await parseJsonBody(req);
        const trip = db.trips.find(t => t.id === tripId);

        if (!trip) {
          const newTrip = { id: tripId, ...updateData };
          db.trips.unshift(newTrip);
          saveDatabase();
          return sendJson(res, 200, { success: true, trip: newTrip });
        }

        // Merge updates
        Object.assign(trip, updateData);

        // Recalculate distance if both odometers exist
        if (trip.endOdometer && trip.startOdometer) {
          trip.distanceKm = Math.max(0, Number(trip.endOdometer) - Number(trip.startOdometer));
        }

        // Sync vehicle odometer if endOdometer provided
        if (trip.endOdometer && db.vehicles) {
          const veh = db.vehicles.find(v => 
            (v.name && trip.vehicle && v.name.toLowerCase().includes(trip.vehicle.toLowerCase())) ||
            (v.driverUsername === trip.driverUsername)
          );
          if (veh) {
            veh.currentOdometer = Math.max(veh.currentOdometer || 0, trip.endOdometer);
            veh.lastUpdated = new Date().toISOString();
          }
        }

        saveDatabase();

        addAuditLogEntry({
          userId: trip.driverUsername,
          username: trip.driverUsername,
          userName: trip.driverName,
          userRole: 'driver',
          actionType: trip.endOdometer ? 'TRIP_COMPLETE' : 'TRIP_UPDATE',
          details: trip.endOdometer
            ? `إنهاء رحلة بواسطة (${trip.driverName}) بالسيارة ${trip.vehicle} (العداد: ${trip.startOdometer} -> ${trip.endOdometer}، مسافة: ${trip.distanceKm || 0} كم)`
            : `تحديث بيانات الرحلة ${trip.id} الخاصة بالسائق (${trip.driverName})`,
          metadata: { tripId: trip.id, distanceKm: trip.distanceKm },
          req
        });

        console.log(`[DB] تم تحديث الرحلة: ${trip.id} (العداد: ${trip.startOdometer} -> ${trip.endOdometer})`);
        return sendJson(res, 200, { success: true, trip });
      }

      // 13. Delete Trip (Admin)
      if (pathname.startsWith('/api/trips/') && method === 'DELETE') {
        const tripId = pathname.replace('/api/trips/', '');
        const index = db.trips.findIndex(t => t.id === tripId);

        if (index === -1) {
          return sendJson(res, 404, { success: false, error: 'الرحلة غير موجودة' });
        }

        const deletedTrip = db.trips.splice(index, 1)[0];
        saveDatabase();

        addAuditLogEntry({
          userId: 'admin',
          username: 'admin',
          userName: 'المشرف',
          userRole: 'admin',
          actionType: 'TRIP_DELETE',
          details: `حذف رحلة السائق (${deletedTrip ? deletedTrip.driverName : tripId}) نهائياً من النظام`,
          metadata: { tripId, driverName: deletedTrip?.driverName, team: deletedTrip?.team },
          req
        });

        console.log(`[DB] تم حذف الرحلة: ${tripId}`);
        return sendJson(res, 200, { success: true, deletedId: tripId });
      }

      // 14. Get Teams / Add Team
      if (pathname === '/api/teams') {
        if (method === 'GET') {
          return sendJson(res, 200, { success: true, teams: db.teams });
        }
        if (method === 'POST') {
          const { teamName } = await parseJsonBody(req);
          if (!teamName || !teamName.trim()) {
            return sendJson(res, 400, { success: false, error: 'اسم الفريق مطلوب' });
          }
          const cleanTeam = teamName.trim();
          if (!db.teams.includes(cleanTeam)) {
            db.teams.push(cleanTeam);
            saveDatabase();
          }
          return sendJson(res, 200, { success: true, teams: db.teams });
        }
      }

      // 15. Fuel Logs Management (سجل تعبئة السولار والوقود)
      // GET: viewable by all users
      if (pathname === '/api/fuel-logs' && method === 'GET') {
        if (!db.fuelLogs) db.fuelLogs = [];
        return sendJson(res, 200, { success: true, fuelLogs: db.fuelLogs });
      }

      // POST: added by fuel officer or admin
      if (pathname === '/api/fuel-logs' && method === 'POST') {
        const body = await parseJsonBody(req);
        const { vehicleName, liters, cost, station, fuelSource, odometer, dateTime, notes, receiptPhoto, recordedBy, recordedByUsername } = body;

        if (!vehicleName || !liters) {
          return sendJson(res, 400, { success: false, error: 'نوع المركبة وكمية السولار باللتر مطلوبة' });
        }

        const resolvedSource = fuelSource || (station && station.includes('مخزون القرية') ? 'village_stock' : 'station');
        const resolvedStation = resolvedSource === 'village_stock' ? 'مخزون القرية الداخلي (خزان SOS)' : (station || 'محطة وقود خارجية').trim();

        const newLog = {
          id: 'FUEL_' + Date.now(),
          vehicleName: vehicleName.trim(),
          liters: Number(liters),
          cost: Number(cost) || 0,
          fuelType: 'سولار (ديزل)',
          fuelSource: resolvedSource,
          station: resolvedStation,
          odometer: Number(odometer) || 0,
          dateTime: dateTime ? new Date(dateTime).toISOString() : new Date().toISOString(),
          notes: (notes || '').trim(),
          receiptPhoto: receiptPhoto || null,
          recordedBy: recordedBy || 'مسؤول السولار',
          recordedByUsername: recordedByUsername || 'fuel',
          createdAt: new Date().toISOString()
        };

        if (!db.fuelLogs) db.fuelLogs = [];
        db.fuelLogs.unshift(newLog);

        // Auto update vehicle current fuel level & last refuel info
        if (db.vehicles) {
          const veh = db.vehicles.find(v => v.name.toLowerCase() === newLog.vehicleName.toLowerCase());
          if (veh) {
            veh.currentFuelLiters = Math.min(veh.fuelCapacityLiters || 60, (veh.currentFuelLiters || 0) + newLog.liters);
            if (newLog.odometer > 0) {
              veh.currentOdometer = Math.max(veh.currentOdometer || 0, newLog.odometer);
            }
            veh.lastRefuel = {
              liters: newLog.liters,
              dateTime: newLog.dateTime,
              station: newLog.station,
              fuelSource: newLog.fuelSource,
              recordedBy: newLog.recordedBy
            };
            veh.lastUpdated = new Date().toISOString();
          }
        }

        saveDatabase();

        addAuditLogEntry({
          userId: newLog.recordedByUsername,
          username: newLog.recordedByUsername,
          userName: newLog.recordedBy,
          userRole: 'fuel_officer',
          actionType: 'FUEL_LOG',
          details: `تسجيل تعبئة سولار: ${newLog.liters} لتر للسيارة (${newLog.vehicleName}) من (${newLog.station}) بتكلفة ${newLog.cost} ₪ (العداد: ${newLog.odometer} كم)`,
          metadata: { logId: newLog.id, vehicle: newLog.vehicleName, liters: newLog.liters, source: newLog.fuelSource },
          req
        });

        console.log(`[DB] تم تسجيل تعبئة سولار: ${newLog.vehicleName} (${newLog.liters}L) - مصدر: ${newLog.fuelSource} بواسطة ${newLog.recordedBy}`);
        return sendJson(res, 201, { success: true, fuelLog: newLog });
      }

      // PUT: ONLY admin can edit fuel logs ("فقط admin الي بقدر يغير")
      if (pathname.startsWith('/api/fuel-logs/') && method === 'PUT') {
        const logId = pathname.replace('/api/fuel-logs/', '');
        const body = await parseJsonBody(req);

        if (body.requesterRole !== 'admin' && body.requesterUsername !== 'admin') {
          return sendJson(res, 403, { success: false, error: 'عذراً، تعديل سجلات تعبئة السولار محصور بحساب المشرف العام (admin) فقط' });
        }

        if (!db.fuelLogs) db.fuelLogs = [];
        const log = db.fuelLogs.find(f => f.id === logId);
        if (!log) return sendJson(res, 404, { success: false, error: 'سجل السولار غير موجود' });

        if (body.vehicleName !== undefined) log.vehicleName = body.vehicleName.trim();
        if (body.liters !== undefined) log.liters = Number(body.liters);
        if (body.cost !== undefined) log.cost = Number(body.cost);
        if (body.odometer !== undefined) log.odometer = Number(body.odometer);
        if (body.fuelSource !== undefined) log.fuelSource = body.fuelSource;
        if (body.station !== undefined) log.station = body.station.trim();
        if (body.dateTime !== undefined) log.dateTime = new Date(body.dateTime).toISOString();
        if (body.notes !== undefined) log.notes = body.notes.trim();
        log.lastEditedBy = 'admin';
        log.lastEditedAt = new Date().toISOString();

        saveDatabase();

        addAuditLogEntry({
          userId: 'admin',
          username: 'admin',
          userName: 'المشرف العام',
          userRole: 'admin',
          actionType: 'FUEL_UPDATE',
          details: `قام المشرف العام بتعديل سجل تعبئة السولار للمركبة (${log.vehicleName})`,
          metadata: { logId: log.id, vehicle: log.vehicleName },
          req
        });

        console.log(`[DB] قام admin بتعديل سجل سولار: ${log.id}`);
        return sendJson(res, 200, { success: true, fuelLog: log });
      }

      // DELETE: ONLY admin can delete fuel logs ("فقط admin الي بقدر يغير")
      if (pathname.startsWith('/api/fuel-logs/') && method === 'DELETE') {
        const logId = pathname.replace('/api/fuel-logs/', '');
        const queryRole = parsedUrl.searchParams.get('role');
        const queryUser = parsedUrl.searchParams.get('username');

        if (queryRole !== 'admin' && queryUser !== 'admin') {
          return sendJson(res, 403, { success: false, error: 'عذراً، حذف سجلات تعبئة السولار محصور بحساب المشرف العام (admin) فقط' });
        }

        if (!db.fuelLogs) db.fuelLogs = [];
        const idx = db.fuelLogs.findIndex(f => f.id === logId);
        if (idx === -1) return sendJson(res, 404, { success: false, error: 'سجل السولار غير موجود' });

        const deletedFuel = db.fuelLogs.splice(idx, 1)[0];
        saveDatabase();

        addAuditLogEntry({
          userId: 'admin',
          username: 'admin',
          userName: 'المشرف العام',
          userRole: 'admin',
          actionType: 'FUEL_DELETE',
          details: `حذف سجل تعبئة سولار للمركبة (${deletedFuel.vehicleName}) بكمية ${deletedFuel.liters} لتر`,
          metadata: { logId, vehicle: deletedFuel.vehicleName, liters: deletedFuel.liters },
          req
        });

        console.log(`[DB] قام admin بحذف سجل سولار: ${logId}`);
        return sendJson(res, 200, { success: true, deletedId: logId });
      }

      // 16. Procurement & Vehicle Financial Accounts (المشتريات، أسعار السيارات، وحسابات الجرد)
      // "يعمل كل سيارة الها حساب ويحط السعر السيارة ويطلع اجمالي اله والكامل مع جرد"
      
      // GET /api/purchases: view all vehicle purchase invoices
      if (pathname === '/api/purchases' && method === 'GET') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        if (queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryUser === 'supervisor' || queryRole === 'driver') {
          return sendJson(res, 403, { success: false, error: 'غير مصرح لمسؤول السائقين أو السائق بالاطلاع على فواتير المشتريات والأسعار' });
        }
        if (!db.purchases) db.purchases = [];
        return sendJson(res, 200, { success: true, purchases: db.purchases });
      }

      // POST /api/purchases: add purchase invoice for a vehicle
      if (pathname === '/api/purchases' && method === 'POST') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        if (queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryUser === 'supervisor' || queryRole === 'driver') {
          return sendJson(res, 403, { success: false, error: 'غير مصرح لمسؤول السائقين بتسجيل فواتير مشتريات مالية' });
        }
        const body = await parseJsonBody(req);
        const { vehicleName, itemType, itemDescription, cost, supplier, invoiceNumber, date, odometer, notes, receiptPhoto, recordedBy, recordedByUsername } = body;

        if (!vehicleName || !itemDescription || !cost) {
          return sendJson(res, 400, { success: false, error: 'نوع المركبة وبيان المشترى والتكلفة بالشيكل مطلوبة' });
        }

        const newPurchase = {
          id: 'PURCH_' + Date.now(),
          vehicleName: vehicleName.trim(),
          itemType: (itemType || 'قطع غيار وصيانة').trim(),
          itemDescription: itemDescription.trim(),
          cost: Number(cost),
          supplier: (supplier || '').trim(),
          invoiceNumber: (invoiceNumber || '').trim(),
          date: date ? new Date(date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          odometer: Number(odometer) || 0,
          notes: (notes || '').trim(),
          receiptPhoto: receiptPhoto || null,
          recordedBy: recordedBy || 'مسؤول المشتريات',
          recordedByUsername: recordedByUsername || 'procurement',
          createdAt: new Date().toISOString()
        };

        if (!db.purchases) db.purchases = [];
        db.purchases.unshift(newPurchase);

        recalculateVehiclePurchases();
        saveDatabase();

        addAuditLogEntry({
          userId: newPurchase.recordedByUsername,
          username: newPurchase.recordedByUsername,
          userName: newPurchase.recordedBy,
          userRole: 'procurement_officer',
          actionType: 'INVOICE_CREATE',
          details: `تسجيل فاتورة مشتريات/صيانة: "${newPurchase.itemDescription}" للمركبة (${newPurchase.vehicleName}) بقيمة ${newPurchase.cost} ₪ من (${newPurchase.supplier || 'مورد'})`,
          metadata: { purchaseId: newPurchase.id, vehicle: newPurchase.vehicleName, cost: newPurchase.cost },
          req
        });

        console.log(`[DB] تم تسجيل فاتورة مشتريات: ${newPurchase.vehicleName} - ${newPurchase.itemDescription} (${newPurchase.cost} ₪)`);
        return sendJson(res, 201, { success: true, purchase: newPurchase });
      }

      // PUT /api/vehicles/:id/price: Update vehicle purchase price ("ويحط السعر السيارة")
      if (pathname.startsWith('/api/vehicles/') && pathname.endsWith('/price') && method === 'PUT') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        if (queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryUser === 'supervisor' || queryRole === 'driver') {
          return sendJson(res, 403, { success: false, error: 'غير مصرح بتعديل أسعار السيارات' });
        }
        const vehicleId = pathname.replace('/api/vehicles/', '').replace('/price', '');
        const body = await parseJsonBody(req);
        const veh = (db.vehicles || []).find(v => v.id === vehicleId || v.name.toLowerCase() === vehicleId.toLowerCase());

        if (!veh) {
          return sendJson(res, 404, { success: false, error: 'المركبة غير موجودة' });
        }

        if (body.purchasePrice !== undefined) veh.purchasePrice = Number(body.purchasePrice);
        if (body.modelYear !== undefined) veh.modelYear = String(body.modelYear).trim();
        if (body.chassisNumber !== undefined) veh.chassisNumber = String(body.chassisNumber).trim();
        if (body.notes !== undefined) veh.notes = String(body.notes).trim();
        veh.lastUpdated = new Date().toISOString();

        saveDatabase();

        addAuditLogEntry({
          userId: 'admin',
          username: 'admin',
          userName: 'المشرف/المشتريات',
          userRole: 'admin',
          actionType: 'PRICE_UPDATE',
          details: `تحديث القيمة/السعر التقديري للمركبة (${veh.name}) إلى (${veh.purchasePrice} ₪)`,
          req
        });

        console.log(`[DB] تم تحديث سعر وقيمة المركبة: ${veh.name} (السعر: ${veh.purchasePrice} ₪)`);
        return sendJson(res, 200, { success: true, vehicle: veh });
      }

      // PUT /api/purchases/:id: Edit purchase invoice
      if (pathname.startsWith('/api/purchases/') && method === 'PUT') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        if (queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryUser === 'supervisor' || queryRole === 'driver') {
          return sendJson(res, 403, { success: false, error: 'غير مصرح لمسؤول السائقين بتعديل فواتير المشتريات' });
        }
        const purchId = pathname.replace('/api/purchases/', '');
        const body = await parseJsonBody(req);
        if (!db.purchases) db.purchases = [];
        const purch = db.purchases.find(p => p.id === purchId);
        if (!purch) return sendJson(res, 404, { success: false, error: 'فاتورة المشتريات غير موجودة' });

        if (body.vehicleName !== undefined) purch.vehicleName = body.vehicleName.trim();
        if (body.itemType !== undefined) purch.itemType = body.itemType.trim();
        if (body.itemDescription !== undefined) purch.itemDescription = body.itemDescription.trim();
        if (body.cost !== undefined) purch.cost = Number(body.cost);
        if (body.supplier !== undefined) purch.supplier = body.supplier.trim();
        if (body.invoiceNumber !== undefined) purch.invoiceNumber = body.invoiceNumber.trim();
        if (body.date !== undefined) purch.date = body.date;
        if (body.odometer !== undefined) purch.odometer = Number(body.odometer);
        if (body.notes !== undefined) purch.notes = body.notes.trim();
        purch.lastEditedAt = new Date().toISOString();

        recalculateVehiclePurchases();
        saveDatabase();

        addAuditLogEntry({
          userId: 'procurement',
          username: 'procurement',
          userName: 'المشتريات',
          userRole: 'procurement_officer',
          actionType: 'INVOICE_UPDATE',
          details: `تعديل فاتورة المشتريات للمركبة (${purch.vehicleName})`,
          metadata: { purchaseId: purchId },
          req
        });

        return sendJson(res, 200, { success: true, purchase: purch });
      }

      // DELETE /api/purchases/:id: Delete purchase invoice
      if (pathname.startsWith('/api/purchases/') && method === 'DELETE') {
        const queryRole = parsedUrl.searchParams.get('role') || (req.headers ? req.headers['x-user-role'] : null);
        const queryUser = parsedUrl.searchParams.get('username') || (req.headers ? req.headers['x-user-username'] : null);
        if (queryRole === 'supervisor' || queryRole === 'supervisor_readonly' || queryUser === 'supervisor' || queryRole === 'driver') {
          return sendJson(res, 403, { success: false, error: 'غير مصرح لمسؤول السائقين بحذف فواتير المشتريات' });
        }
        const purchId = pathname.replace('/api/purchases/', '');
        if (!db.purchases) db.purchases = [];
        const idx = db.purchases.findIndex(p => p.id === purchId);
        if (idx === -1) return sendJson(res, 404, { success: false, error: 'فاتورة المشتريات غير موجودة' });

        const deletedPurch = db.purchases.splice(idx, 1)[0];
        recalculateVehiclePurchases();
        saveDatabase();

        addAuditLogEntry({
          userId: 'admin',
          username: 'admin',
          userName: 'المشرف',
          userRole: 'admin',
          actionType: 'INVOICE_DELETE',
          details: `حذف فاتورة مشتريات/صيانة للمركبة (${deletedPurch.vehicleName}) بقيمة ${deletedPurch.cost} ₪`,
          metadata: { purchaseId: purchId },
          req
        });

        console.log(`[DB] تم حذف فاتورة مشتريات: ${purchId}`);
        return sendJson(res, 200, { success: true, deletedId: purchId });
      }

      // ==========================================
      // 17. Audit Logs & Real-Time Notification System (سجل الرقابة ونظام الإشعارات)
      // ==========================================

      // GET /api/audit-logs: View audit trail records with filters & pagination
      if (pathname === '/api/audit-logs' && method === 'GET') {
        if (!db.auditLogs) db.auditLogs = [];
        const limit = Math.min(Number(parsedUrl.searchParams.get('limit')) || 150, 500);
        const actionType = parsedUrl.searchParams.get('actionType');
        const username = parsedUrl.searchParams.get('username');
        const since = parsedUrl.searchParams.get('since');

        let logs = db.auditLogs;
        if (actionType && actionType !== 'all') {
          logs = logs.filter(l => l.actionType === actionType);
        }
        if (username && username !== 'all') {
          logs = logs.filter(l => (l.username || '').toLowerCase() === username.toLowerCase());
        }
        if (since) {
          const sinceTime = new Date(since).getTime();
          logs = logs.filter(l => new Date(l.timestamp).getTime() > sinceTime);
        }

        return sendJson(res, 200, {
          success: true,
          total: db.auditLogs.length,
          logs: logs.slice(0, limit),
          serverTime: new Date().toISOString()
        });
      }

      // POST /api/audit-logs: Log client-side events (Data exports, module opens, clicks)
      if (pathname === '/api/audit-logs' && method === 'POST') {
        const body = await parseJsonBody(req);
        const { actionType, details, userId, username, userName, userRole, metadata } = body;

        if (!actionType || !details) {
          return sendJson(res, 400, { success: false, error: 'نوع الحركة والتفاصيل مطلوبة' });
        }

        const entry = addAuditLogEntry({
          userId,
          username,
          userName,
          userRole,
          actionType,
          details,
          metadata: metadata || {},
          req
        });

        return sendJson(res, 201, { success: true, log: entry });
      }

      // DELETE /api/audit-logs: Clear logs (Admin only)
      if (pathname === '/api/audit-logs' && method === 'DELETE') {
        const queryRole = parsedUrl.searchParams.get('role');
        const queryUser = parsedUrl.searchParams.get('username');

        if (queryRole !== 'admin' && queryUser !== 'admin') {
          return sendJson(res, 403, { success: false, error: 'عذراً، مسح وتفريغ سجل الرقابة محصور بالمشرف العام (admin) فقط' });
        }

        const prevCount = (db.auditLogs || []).length;
        db.auditLogs = [];
        saveDatabase();

        addAuditLogEntry({
          userId: queryUser || 'admin',
          username: queryUser || 'admin',
          userName: 'المشرف العام',
          userRole: 'admin',
          actionType: 'AUDIT_CLEAR',
          details: `قام المشرف العام بتفريغ سجل الرقابة ومسح ${prevCount} سجل سابق`,
          req
        });

        return sendJson(res, 200, { success: true, message: 'تم تفريغ السجل بنجاح' });
      }

      // Unknown API route
      return sendJson(res, 404, { success: false, error: 'API route not found' });

    } catch (apiErr) {
      console.error('[API Error]:', apiErr);
      return sendJson(res, 500, { success: false, error: apiErr.message });
    }
  }

  // ==========================================
  // Static File Serving
  // ==========================================

  let safePath = pathname;
  if (safePath === '/') {
    safePath = '/index.html';
  }

  const filePath = path.join(__dirname, safePath);

  // Security check: ensure path is within directory
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    };

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
});

function getLocalIpAddresses() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIpAddresses();
  const primaryIp = localIps[0] || '127.0.0.1';
  console.log(`=======================================================`);
  console.log(` 🚗 قرى الأطفال SOS - سجل رحلات السائقين والأسطول`);
  console.log(` 🌐 افتح الرابط على هذا اللابتوب: http://localhost:${PORT}`);
  localIps.forEach(ip => {
    console.log(` 📱 على الهاتف (نفس شبكة الواي فاي): http://${ip}:${PORT}`);
  });
  console.log(` 💾 قاعدة بيانات مركزية مدمجة (JSON Sync Engine)`);
  console.log(`=======================================================`);
});
