# UPSA Announcements Scraper

Scrapes announcements from upsa.edu.gh and pushes them to Firebase Firestore.
Runs automatically every 6 hours via GitHub Actions.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Add Firebase service account key
- Go to Firebase Console → Project Settings → Service Accounts
- Click "Generate new private key"
- Save the downloaded JSON as `serviceAccountKey.json` in this folder
- Never commit this file (it's in .gitignore)

### 3. Test locally
```bash
npm run scrape
```

### 4. Deploy to GitHub Actions
- Create a new GitHub repo
- Push this project to it
- Go to repo → Settings → Secrets and variables → Actions
- Add a secret named `FIREBASE_KEY`
- Paste the entire contents of your serviceAccountKey.json as the value
- Go to Actions tab → Run workflow manually to test

## How it works
- Scrapes h3 titles and links from upsa.edu.gh/announcements
- Fetches body text from each individual announcement page
- Uses the URL slug as the Firestore document ID (prevents duplicates)
- Skips announcements already in Firebase
- Runs every 6 hours automatically
