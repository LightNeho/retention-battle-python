/**
 * CacheHelper.gs
 * עטיפה ל-CacheService המובנה של Google. משמש להפחתת קריאות ל-Sheet.
 * TTL קצר (5 דקות) - מספיק כדי לחסוך עומס בלי לגרום לנתונים "תקועים".
 */

var CACHE_TTL_SECONDS = 300;

function cacheGet(key) {
  var raw = CacheService.getScriptCache().get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function cachePut(key, value) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), CACHE_TTL_SECONDS);
  } catch (e) {
    // אובייקט גדול מדי ל-Cache (מגבלת 100KB) - פשוט מדלגים, לא קריטי
  }
}

function cacheRemove(key) {
  CacheService.getScriptCache().remove(key);
}

/** מנקה את כל מפתחות ה-Cache הרלוונטיים לשבוע נתון - נקרא אחרי כל כתיבה */
function invalidateWeekCache(weekId) {
  var keys = [
    'dashboard_' + weekId,
    'leaderboard_agents_' + weekId,
    'leaderboard_teams_' + weekId,
    'leaderboard_leaders_' + weekId,
    'activity_feed_' + weekId,
    'hall_of_fame'
  ];
  keys.forEach(cacheRemove);
}

/** דפוס עזר: נסה מה-Cache, אם ריק - חשב, שמור, החזר */
function withCache(key, computeFn) {
  var cached = cacheGet(key);
  if (cached !== null) return cached;
  var fresh = computeFn();
  cachePut(key, fresh);
  return fresh;
}
