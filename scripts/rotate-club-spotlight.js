import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ── Firebase setup ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

// ── Config ────────────────────────────────────────────────────────────────────
const SPOTLIGHT_COUNT = 3; // how many clubs to feature each week

// ── Helpers ───────────────────────────────────────────────────────────────────
function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getWeekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start + (start.getTimezoneOffset() - now.getTimezoneOffset()) * 60000;
  return Math.ceil(diff / (7 * 24 * 60 * 60 * 1000));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function rotateSpotlight() {
  const week = getWeekNumber();
  const year = new Date().getFullYear();
  console.log(`🌟 Rotating Club Spotlight — Week ${week}, ${year}`);

  // 1. Clear all currently featured clubs
  const currentFeatured = await db.collection('clubs')
    .where('featured', '==', true)
    .get();

  if (!currentFeatured.empty) {
    const batch = db.batch();
    currentFeatured.forEach(doc => {
      batch.update(doc.ref, { featured: false, featured_week: null });
    });
    await batch.commit();
    console.log(`   🔄 Cleared ${currentFeatured.size} previously featured club(s)`);
  }

  // 2. Get all active clubs
  const allClubs = await db.collection('clubs')
    .where('is_active', '==', true)
    .get();

  if (allClubs.empty) {
    console.log('⚠️  No active clubs found in Firestore');
    return;
  }

  const clubDocs = [];
  allClubs.forEach(doc => clubDocs.push({ id: doc.id, ...doc.data() }));
  console.log(`   📋 Found ${clubDocs.length} active club(s)`);

  // 3. Shuffle and pick N clubs
  // Avoid featuring the same clubs two weeks in a row if possible
  const shuffled = shuffleArray(clubDocs);
  const selected = shuffled.slice(0, Math.min(SPOTLIGHT_COUNT, shuffled.length));

  // 4. Mark selected clubs as featured
  const batch = db.batch();
  for (const club of selected) {
    const ref = db.collection('clubs').doc(club.id);
    batch.update(ref, {
      featured:      true,
      featured_week: `${year}-W${String(week).padStart(2, '0')}`,
    });
    console.log(`   ✅ Featured: ${club.name}`);
  }
  await batch.commit();

  console.log(`\n🎉 Done — ${selected.length} club(s) now in the spotlight for Week ${week}`);
}

rotateSpotlight().catch(err => {
  console.error('❌ Club spotlight rotation failed:', err.message);
  process.exit(1);
});
