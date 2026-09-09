/**
 * Code.gs
 * נקודת הכניסה של ה-Web App.
 */

function doGet(e) {
  var mode = (e && e.parameter && e.parameter.mode) || 'app'; // 'app' | 'tv'
  var template = HtmlService.createTemplateFromFile('Index');
  template.tvMode = (mode === 'tv');
  return template.evaluate()
    .setTitle('RETENTION BATTLE')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** מאפשר Include של קבצי HTML/CSS/JS נפרדים בתוך Index.html */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** תפריט נוח בגיליון עצמו, כדי שלא יהיה צורך לחפש את הפונקציה בעורך הסקריפט */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚔️ Retention Battle')
    .addItem('הרצת התקנה ראשונית (Setup)', 'setupCompetitionSystem')
    .addItem('סגירת השבוע הנוכחי', 'closeCurrentWeekFromMenu')
    .addToUi();
}

function closeCurrentWeekFromMenu() {
  var ui = SpreadsheetApp.getUi();
  var adminUser = readSheet(SHEET_NAMES.USERS).filter(function (u) { return u.Role === 'ADMIN'; })[0];
  if (!adminUser) { ui.alert('לא נמצא משתמש Admin במערכת'); return; }
  var confirm = ui.alert('לסגור את השבוע הנוכחי?', 'פעולה זו תיצור Snapshot ותפתח שבוע חדש. לא ניתן לבטל.', ui.ButtonSet.YES_NO);
  if (confirm === ui.Button.YES) {
    var result = closeCurrentWeek(adminUser.UserId);
    ui.alert('השבוע ' + result.closedWeekId + ' נסגר בהצלחה. השבוע החדש: ' + result.newWeekId);
  }
}
