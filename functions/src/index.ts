import app from "./app";

// سيرفر Node.js عادي (بيشتغل على Render أو أي استضافة Node تانية) - مش Firebase
// Function. Render بيحدد رقم البورت أوتوماتيك عن طريق متغير البيئة PORT.
const port = Number(process.env.PORT) || 8080;

app.listen(port, () => {
  console.log(`Gameora API listening on port ${port}`);
});
