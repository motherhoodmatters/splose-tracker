# Splose Client Support Tracker

A simple app that pulls your clients and appointments from Splose and shows
who is active, ending soon, or past their 10-business-day support period.

---

## What you need first

1. **Node.js 18 or later** — download from https://nodejs.org (choose the LTS version)
2. **Your Splose API key** — in Splose go to Settings → API → Generate key

---

## Setup (one time only)

1. Unzip this folder somewhere on your computer
2. Open **Terminal** (Mac) or **Command Prompt** (Windows)
3. Navigate to the folder:
   ```
   cd path/to/splose-tracker
   ```
4. Install dependencies:
   ```
   npm install
   ```

---

## Running the app

**Mac / Linux:**
```
SPLOSE_API_KEY=your_key_here npm start
```

**Windows:**
```
set SPLOSE_API_KEY=your_key_here && npm start
```

Then open your browser and go to: **http://localhost:3000**

Click **"Sync from Splose"** to load your clients.

---

## Sharing with your practice manager

### Option A — Same computer / same network
If you're on the same Wi-Fi, your practice manager can open:
`http://YOUR_COMPUTER_IP:3000`
(Find your IP in System Preferences → Network on Mac, or ipconfig on Windows)

### Option B — Shared online access (recommended)
Deploy to Render.com for free so anyone can access it from anywhere:

1. Create a free account at https://render.com
2. Upload this folder to a GitHub repository
3. In Render: New → Web Service → connect your GitHub repo
4. Set environment variable: `SPLOSE_API_KEY` = your key
5. Render gives you a URL like `https://your-app.onrender.com`

---

## How support periods work

- **Initial contact** = date of the client's first appointment in Splose
- **Support end date** = 10 business days (Mon–Fri) after initial contact
- **Active** = within the support window
- **Ending soon** = 2 or fewer business days remaining
- **Period ended** = support window has passed

Data is refreshed from Splose each time you click "Sync from Splose".
