# Gameora Backend (Node.js + Express + Firestore) — يشتغل مجانًا من غير أي بطاقة

سيرفر حقيقي لتطبيق Gameora، بيطبّق بالظبط نفس الـ endpoints الموجودة في
`ApiService.kt` بتاع الأندرويد. الداتا محفوظة في Firestore (مجاني بالكامل)،
والسيرفر نفسه بيشتغل على **Vercel** — استضافة مجانية بتقبل حسابات من غير
أي بطاقة بنكية.

**مش محتاج تلمس كود الأندرويد خالص** — بس هتغيّر سطر واحد فيه (API_BASE_URL) في الآخر.

---

## الخطوات (كلها ممكن تتعمل من الموبايل)

### 1) فعّل Firestore بس (لو لسه معملتوش)
1. روح [console.firebase.google.com](https://console.firebase.google.com) → افتح مشروعك (أو اعمل واحد جديد لو مفيش)
2. من القائمة الجانبية: **Build → Firestore Database** → **Create database** → **Production mode** → اختار أي موقع سيرفر قريب → **Enable**
3. الخطوة دي **مش محتاجة خطة Blaze ولا بطاقة بنكية خالص** — دي غير Cloud Functions تمامًا.

### 2) الصق قواعد الأمان مباشرة (من غير أي CLI)
1. في نفس صفحة Firestore، افتح تبويب **Rules** فوق
2. امسح اللي موجود، والصق محتوى ملف `firestore.rules` الموجود في المشروع ده بالكامل
3. دوس **Publish**

### 3) اعمل Service Account Key
1. من Firebase Console: ⚙️ Project settings → تبويب **Service accounts**
2. **Generate new private key** → هينزلّك ملف `.json`
3. افتحه وانسخ **كل محتواه** (من `{` لحد `}`)

### 4) اعمل حساب على Vercel (من غير بطاقة خالص)
1. روح [vercel.com](https://vercel.com/signup) وسجّل بحساب GitHub بتاعك مباشرة (مفيش أي طلب بطاقة في التسجيل)
2. من الداشبورد: **Add New...** → **Project**
3. اختار ريبو الـ backend ده من القائمة → **Import**
4. في شاشة الإعدادات قبل ما تعمل Deploy:
   - **Root Directory:** دوس Edit واختار `functions`
   - **Framework Preset:** سيبه **Other**
   - **Build Command:** امسحه خالي (Override → سيب الخانة فاضية)
   - **Output Directory:** سيبه زي ما هو (Vercel هيتكفل بيها)
5. افتح **Environment Variables** وضيف التلاتة دول:

   | الاسم | القيمة |
   |---|---|
   | `JWT_SECRET` | أي نص عشوائي طويل (اكتب أي حاجة 30-40 حرف) |
   | `ADMIN_SEED_KEY` | كلمة سر بسيطة، هتستخدمها بعدين |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | الصق محتوى ملف الـ json كامل من خطوة 3 |

6. دوس **Deploy**

Vercel هيبني وينشر لوحده، وهيديك رابط في الآخر شكله زي:
```
https://gameora-backend-xxxx.vercel.app
```

### 5) ضيف ألعاب وفئات تجريبية (مرة واحدة)
افتح من متصفح الموبايل:
```
https://gameora-backend-xxxx.vercel.app/seed.html
```
حط قيمة `ADMIN_SEED_KEY` اللي حطيتها فوق، ودوس الزرار.

### 6) وصّل الأندرويد بالسيرفر
في ريبو الأندرويد، افتح `app/build.gradle` وابدّل السطرين دول:
```gradle
buildConfigField "String", "API_BASE_URL", "\"https://gameora-backend-xxxx.vercel.app/\""
buildConfigField "String", "IMAGE_BASE_URL", "\"https://gameora-backend-xxxx.vercel.app/\""
```
(خلي بالك من الـ `/` في الآخر — لازم يكون موجود)

اعمل commit وpush — الـ workflow بتاع الأندرويد هيبني APK جديد أوتوماتيك.

---

## بديل: لو Vercel برضو طلب بطاقة عندك (بيختلف أحيانًا حسب الدولة)

نفس الكود شغال على **Railway.app** برضو من غير بطاقة في البداية (بياخد $5 رصيد مجاني أول شهر). نفس الخطوات بالظبط، الفرق بس:
- **Root Directory:** `functions`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- نفس الـ 3 environment variables

ملف `render.yaml` الموجود جوه المشروع ده لو حبيت تجرب Render برضو (بعض الحسابات بتقدر تعمل free web service من غير بطاقة، بيختلف حسب الدولة والحساب).

---

## ملاحظات مهمة

- **من كل push على GitHub، Vercel بينشر تلقائي لوحده** — بالظبط زي GitHub Actions، بس مش محتاج تعمل حاجة إضافية.
- **مفيش endpoint لإضافة ألعاب/فئات من التطبيق نفسه** — بتتضاف بس عن طريق صفحة `seed.html` أو مباشرة من Firestore Console.
- **زرار "تواصل مع البائع"** في شاشة تفاصيل المنتج حاليًا بيعمل بس رسالة toast — مفيش كود في الأندرويد بيفتح شات فعلي معاه (من المشروع الأصلي، مش حاجة إحنا كسرناها).
- منطق الطلبات (orders): السيرفر بيتأكد من توفر المنتج، بيحسب السعر من قاعدة البيانات (مش من اللي بيبعته التطبيق)، وبيتحقق من رصيد المشتري قبل ما ينشئ أي أوردر.
- خطط Vercel/Railway المجانية فيها حدود استخدام شهرية (bandwidth/execution time) كافية جدًا لمشروع شخصي صغير، بس لو التطبيق كبر قوي يوم من الأيام هتحتاج تترقى.
