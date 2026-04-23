import admin from 'firebase-admin';
import { readFileSync } from 'fs';

// ── Firebase setup ────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(readFileSync('./serviceAccountKey.json', 'utf8'));

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();

// ── Config ────────────────────────────────────────────────────────────────────
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// Days before deadline to send reminders
const REMINDER_DAYS = [10, 8, 5, 3, 1];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDaysUntil(date) {
  const now  = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date.toDate());
  target.setHours(0, 0, 0, 0);
  return Math.round((target - now) / (1000 * 60 * 60 * 24));
}

function getReminderMessage(daysLeft, title) {
  const shortTitle = title.length > 60 ? title.slice(0, 60) + '…' : title;
  if (daysLeft === 1)  return { heading: '⚠️ Fee deadline tomorrow!',   body: `"${shortTitle}" is due tomorrow. Don't miss it.` };
  if (daysLeft === 3)  return { heading: '⏰ Fee deadline in 3 days',    body: `"${shortTitle}" is due in 3 days.` };
  if (daysLeft === 5)  return { heading: '📅 Fee deadline in 5 days',    body: `"${shortTitle}" is due in 5 days. Sort it early.` };
  if (daysLeft === 8)  return { heading: '📅 Fee deadline coming up',    body: `"${shortTitle}" is due in 8 days.` };
  if (daysLeft === 10) return { heading: '📅 Upcoming fee deadline',     body: `"${shortTitle}" is due in 10 days. Plan ahead.` };
  return null;
}

// Send a batch of Expo push notifications (max 100 per request)
async function sendExpoPushBatch(messages) {
  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method:  'POST',
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    const result = await response.json();
    const errors = result.data?.filter(r => r.status === 'error') || [];
    if (errors.length) {
      console.warn(`   ⚠️  ${errors.length} push(es) failed:`, errors.map(e => e.message).join(', '));
    }
    return result.data?.filter(r => r.status === 'ok').length || 0;
  } catch (err) {
    console.error('   ❌ Push send failed:', err.message);
    return 0;
  }
}

// Chunk array into batches of N
function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function sendReminders() {
  console.log('🔔 Checking fee deadlines for reminders...');

  // 1. Get all active fee deadlines that have a date
  const deadlineSnap = await db.collection('fee_deadlines')
    .where('is_active', '==', true)
    .get();

  const dueTodayDeadlines = [];

  for (const doc of deadlineSnap.docs) {
    const data = doc.data();
    if (!data.date) continue;

    const daysLeft = getDaysUntil(data.date);
    if (!REMINDER_DAYS.includes(daysLeft)) continue;

    const msg = getReminderMessage(daysLeft, data.title);
    if (!msg) continue;

    // Check if we already sent this reminder today to avoid duplicates
    const reminderKey = `${doc.id}_${daysLeft}d`;
    const sentRef = db.collection('sent_reminders').doc(reminderKey);
    const alreadySent = await sentRef.get();
    if (alreadySent.exists) {
      console.log(`   ⏭  Already sent ${daysLeft}d reminder for: ${data.title.slice(0, 40)}`);
      continue;
    }

    dueTodayDeadlines.push({ deadline: data, daysLeft, msg, reminderKey, sentRef });
  }

  if (!dueTodayDeadlines.length) {
    console.log('ℹ️  No reminders to send today');
    return;
  }

  console.log(`📋 ${dueTodayDeadlines.length} reminder(s) to send`);

  // 2. Get all user push tokens
  const usersSnap = await db.collection('users')
    .where('push_token', '!=', null)
    .get();

  const tokens = [];
  usersSnap.forEach(doc => {
    const token = doc.data().push_token;
    if (token && token.startsWith('ExponentPushToken')) tokens.push(token);
  });

  if (!tokens.length) {
    console.log('⚠️  No push tokens found in users collection');
    return;
  }

  console.log(`👥 ${tokens.length} device(s) to notify`);

  // 3. Send notifications for each deadline
  let totalSent = 0;

  for (const { deadline, daysLeft, msg, reminderKey, sentRef } of dueTodayDeadlines) {
    console.log(`\n📤 Sending ${daysLeft}d reminder: ${deadline.title.slice(0, 50)}...`);

    const messages = tokens.map(token => ({
      to:    token,
      title: msg.heading,
      body:  msg.body,
      data:  {
        type:   'fee_reminder',
        screen: 'fees',
      },
      sound:    'default',
      priority: daysLeft <= 3 ? 'high' : 'normal',
    }));

    // Send in batches of 100 (Expo limit)
    let sent = 0;
    for (const batch of chunk(messages, 100)) {
      sent += await sendExpoPushBatch(batch);
    }

    totalSent += sent;
    console.log(`   ✅ Sent to ${sent}/${tokens.length} devices`);

    // Mark this reminder as sent so it doesn't fire again today
    await sentRef.set({
      deadline_id: reminderKey,
      days_left:   daysLeft,
      sent_at:     admin.firestore.FieldValue.serverTimestamp(),
      sent_count:  sent,
    });
  }

  console.log(`\n🎉 Done — ${totalSent} total notifications sent`);
}

sendReminders().catch(err => {
  console.error('❌ Reminder sender failed:', err.message);
  process.exit(1);
});
