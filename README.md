# RETENTION BATTLE Python

גרסת Flask/Python לפרויקט המקורי שנכתב ב-Google Apps Script.

## מבנה הפרויקט

```text
app.py                    # נקודת כניסה מקומית
api/index.py              # נקודת כניסה ל-Vercel
retention_battle/
  api.py                  # dispatcher ל-API שה-Frontend קורא אליו
  auth.py                 # התחברות, PIN וטוקנים
  db.py                   # שכבת SQLite
  reviews.py              # שמירת שיחות והיסטוריית נציג
  scoring.py              # ניקוד ודירוגים
  seed.py                 # יצירת DB ונתוני דמו
  settings.py             # קונפיגורציה
templates/                # ה-UI המקורי מותאם ל-Flask/Jinja
```

## הרצה מקומית

```bash
pip install -r requirements.txt
python app.py
```

המערכת יוצרת SQLite מקומי בשם `retention_battle.db` בהפעלה הראשונה וממלאת נתוני דמו.

## פריסה ל-Vercel

1. העלה את התיקייה ל-GitHub.
2. צור Project חדש ב-Vercel מתוך הריפו.
3. הוסף Environment Variable בשם `AUTH_SECRET` עם ערך ארוך וסודי.
4. Deploy.

חשוב: SQLite מתאים לפיתוח בלבד. ב-Vercel הקובץ נכתב ל-`/tmp` כדי שפעולות כתיבה כמו הרשמה יעבדו, אבל זה אחסון זמני ועלול להתאפס בין הרצות/פריסות. לפרודקשן אמיתי צריך לחבר DB חיצוני כמו Neon/Supabase/Postgres. כרגע שכבת ה-DB מופרדת ב-`retention_battle/db.py`, כך שזה המקום להוסיף adapter ל-Postgres.

## מה כבר עובד בגרסת Python

- התחברות עם PIN וטוקן חתום.
- הרשמה ראשונה לנציגים.
- דירוג נציגים, צוותים וראשי צוותים.
- שמירת בדיקת שיחה.
- Dashboard, Analytics, Hall of Fame, Admin overview ו-Weekly wrap-up במבנה שה-Frontend מצפה לו.
- בדיקות הרשאה בסיסיות לפעולות ניהול.
