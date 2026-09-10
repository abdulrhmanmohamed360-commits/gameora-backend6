import app from "../src/app";

// Vercel بيستدعي الملف ده كدالة serverless واحدة، وبيمرّرلها كل الطلبات اللي
// بتتوافق مع الـ rewrites الموجودة في vercel.json. الـ Express app نفسه (app)
// هو دالة (req, res) => void بالظبط زي اللي Vercel محتاجاه، فمش محتاجين أي wrapper.
export default app;
