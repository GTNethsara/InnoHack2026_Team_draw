# INNOHACK – Railway + MongoDB Atlas + Vercel (සිංහල Deployment Guide)

මෙම project එකේ frontend එක Vercel වෙතත්, Node.js/Express backend එක Railway වෙතත්, data MongoDB Atlas වෙතත් deploy කරයි. Production එකේ `server/data/store.json` භාවිත නොවේ.

## 1. අවශ්‍ය දේවල්

- Node.js 20 හෝ ඊට ඉහළ version එකක්
- GitHub account එකක්
- Railway account එකක්
- MongoDB Atlas account එකක්
- Vercel account එකක්

## 2. MongoDB Atlas Free Cluster එක සකස් කිරීම

1. https://www.mongodb.com/cloud/atlas වෙත ගොස් account එකක් සාදන්න.
2. Free (M0) cluster එකක් create කරන්න.
3. Database Access යටතේ database user එකක් සාදන්න. ශක්තිමත් password එකක් යොදන්න.
4. Network Access යටතේ Railway වෙතින් connection ලබාගැනීමට IP access list එක configure කරන්න. Railway dynamic egress භාවිත කරන අවස්ථාවක `0.0.0.0/0` අවශ්‍ය විය හැක. මෙය ඕනෑම IP එකකින් connection උත්සාහ කිරීමට ඉඩ දෙන නිසා ශක්තිමත් database username/password එකක් සහ අවම privileges භාවිත කරන්න. Static egress IP තිබේ නම් එය පමණක් allowlist කරන්න.
5. Cluster එකේ **Connect → Drivers** තෝරා MongoDB connection string එක copy කරන්න.
6. `<password>` වෙනුවට database user password එක යොදන්න. Password එකේ `@`, `#`, `/`, `:` වැනි special characters තිබේ නම් URL-encode කරන්න.
7. Database name එක `innohack` ලෙස භාවිත කරන්න. Connection string එක `MONGODB_URI` variable එකට යොදනු ඇත.

## 3. Local project එක සකස් කිරීම

Project root folder එකේ terminal එකක් විවෘත කර:

```bash
npm install
```

`server/data/store.json` file එක project එකේ local copy එකේ තිබිය යුතුයි. මෙම file එකේ team records සහ credential hashes අඩංගු බැවින් එය private backup එකක් ලෙස සලකන්න. GitHub වෙත commit නොකරන්න.

`functions/src/authorizedTeams.ts` file එකේ plaintext team registration codes තිබෙනවා. එය migration එකට පමණක් අවශ්‍ය private input එකකි. GitHub වෙත commit නොකරන්න. `.gitignore` තුළ එය ignore කර ඇත. එය කලින් Git එකට add/commit කර තිබුණා නම්:

```bash
git rm --cached functions/src/authorizedTeams.ts
```

මෙම command එක Git index එකෙන් පමණක් ඉවත් කරයි; local file එක මකා නොදමයි.

## 4. Production secrets generate කිරීම

Windows PowerShell terminal එකේ පහත command දෙවරක් ධාවනය කර වෙනස් secret දෙකක් සාදාගන්න:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

- පළමු output එක `INNOHACK_AUTH_PEPPER` සඳහා.
- දෙවන output එක `INNOHACK_SESSION_SECRET` සඳහා.
- Admin සඳහා වෙනම දිගු, අනුමාන කළ නොහැකි passcode එකක් තෝරන්න.

මෙම values කිසිවිටෙක `VITE_` prefix එකක් සහිතව තබන්න එපා. ඒවා browser වෙත expose නොවිය යුතුයි.

## 5. පරණ JSON data එක MongoDB වෙත migrate කිරීම

මෙය Railway deploy කිරීමට පෙර local machine එකේ එක් වරක් කරන්න. PowerShell තුළ:

```powershell
$env:MONGODB_URI="mongodb+srv://DB_USER:DB_PASSWORD@YOUR_CLUSTER.mongodb.net/?retryWrites=true&w=majority"
$env:MONGODB_DATABASE="innohack"
$env:INNOHACK_AUTH_PEPPER="PASTE_THE_FIRST_RANDOM_SECRET_HERE"
npm run migrate:mongodb
```

Migration script එක:

- `server/data/store.json` කියවයි.
- Teams 30ක් සහ credential records 30ක් තිබෙනවාද පරීක්ෂා කරයි.
- Private team seed file එකේ registration codes භාවිත කර credential hashes අලුත් production pepper එකෙන් නැවත සාදයි.
- `portalState` collection එකේ `innohack-primary-state` document එකක් insert කරයි.
- MongoDB එකේ දැනට state document එකක් තිබේ නම් overwrite නොකර නවතී.

සාර්ථක නම් `Migration successful` පණිවිඩය පෙන්වයි. Original JSON file එක backup එකක් ලෙස තබාගන්න. Migration එක සාර්ථකදැයි තහවුරු කිරීමට Atlas → Browse Collections → `innohack` → `portalState` වෙත ගොස් `innohack-primary-state` document එක තිබෙනවාද බලන්න.

**වැදගත්:** migration script එක credential hashes re-key කරන නිසා production Railway variable එකේ `INNOHACK_AUTH_PEPPER` අගය migration එකේදී භාවිත කළ අගයම විය යුතුයි. වෙනස් කළොත් team logins අසාර්ථක වේ.

## 6. Railway backend deploy කිරීම

1. https://railway.com/ වෙත ගොස් sign in කරන්න.
2. **New Project → Deploy from GitHub Repo** තෝරා project repository එක connect කරන්න.
3. Root directory එක project root ලෙස තබන්න.
4. `railway.json` build command `npm install --include=dev && npm run build` සහ start command `npm run start` ලෙස тохируулагдсан.
5. Railway service → **Variables** хэсයට පහත variables එකතු කරන්න:

```env
NODE_ENV=production
MONGODB_URI=mongodb+srv://DB_USER:DB_PASSWORD@YOUR_CLUSTER.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=innohack
INNOHACK_AUTH_PEPPER=THE_SAME_SECRET_USED_DURING_MIGRATION
INNOHACK_SESSION_SECRET=YOUR_SECOND_RANDOM_SECRET
INNOHACK_ADMIN_PASSCODE=YOUR_STRONG_ADMIN_PASSCODE
FRONTEND_ORIGINS=https://YOUR-PROJECT.vercel.app
DISABLE_SANDBOX_RESET=true
```

`PORT` variable එක Railway විසින් ලබාදෙන නිසා සාමාන්‍යයෙන් අතින් set කිරීම අවශ්‍ය නැහැ. `MONGODB_URI` සහ secrets කිසිවිටෙක frontend/Vercel variables වලට දාන්න එපා.

6. Deploy එක complete වූ පසු Railway → Settings → Networking වෙත ගොස් **Generate Domain** කරන්න.
7. Railway domain එක මෙවැනි එකක් වේ: `https://your-service.up.railway.app`.
8. Browser එකෙන් `https://your-service.up.railway.app/api/health` open කරන්න. `ok: true` පෙන්විය යුතුයි.

MongoDB state document එක කලින් migrate කර නොමැති නම් backend එක production mode එකේ start නොවී error එකක් ලබාදේ. එය data නැතිවීම වැළැක්වීමට ඇති ආරක්ෂාවකි.

## 7. Vercel frontend deploy කිරීම

1. https://vercel.com/ වෙත ගොස් GitHub repository එක import කරන්න.
2. Framework preset `Vite` ලෙස තෝරන්න.
3. Build command `npm run build` සහ output directory `dist` ලෙස තබන්න.
4. Vercel → Project → Settings → Environment Variables තුළ පහත variable එක add කරන්න:

```env
VITE_API_BASE_URL=https://YOUR-RAILWAY-SERVICE.up.railway.app
```

5. Production, Preview, Development අවශ්‍ය පරිසරයන්ට variable එක set කරන්න. Production deploy එකක් නැවත කරන්න.
6. Vercel domain එක ලැබුණු පසු Railway හි `FRONTEND_ORIGINS` value එකට එම exact origin එක යොදන්න. උදා: `https://innohack-portal.vercel.app`. Custom domain එකක් තිබේ නම් එයත් comma-separated list එකට එක් කරන්න.
7. Railway backend එක නැවත deploy කරන්න.

CORS origin එක protocol සහ hostname එක සමඟ හරියටම ගැළපිය යුතුයි. Trailing slash එකක් දාන්න එපා.

## 8. Production test checklist

- [ ] `https://YOUR-RAILWAY-DOMAIN/api/health` → `ok: true`
- [ ] Vercel website එක load වේ.
- [ ] Login page එකේ public arena status පෙන්වයි.
- [ ] වලංගු Student ID + Registration Code එකෙන් team login වේ.
- [ ] Queue එකට join වූ පසු refresh කළත් queue position එක පවතී.
- [ ] Active team එකට පමණක් spin කළ හැක.
- [ ] Draw result එක refresh කිරීමෙන් පසුවත් පවතී.
- [ ] Admin login එක Railway `INNOHACK_ADMIN_PASSCODE` value එකෙන් සාර්ථක වේ.
- [ ] දෙවන browser එකකින් status/queue updates බලන්න.
- [ ] MongoDB Atlas → `innohack.portalState` document එකේ `updatedAt` වෙනස් වන බව බලන්න.

## 9. Local development

Local development සඳහා MongoDB URI නොමැතිව JSON fallback එක භාවිත කළ හැක:

```bash
npm run dev:full
```

- Vite frontend: `http://localhost:5173`
- Express API: `http://localhost:3001`
- API calls Vite proxy එකෙන් local backend වෙත යයි.

Local `.env` එකක `INNOHACK_AUTH_PEPPER` set නොකරන්නේ නම් legacy local credential hashes verify කිරීමට local development fallback එක භාවිත වේ. Production එකේ එම fallback එක භාවිත නොවේ.

## 10. වැදගත් architecture සහ security සීමා

1. දැනට application state එක MongoDB හි එක් `portalState` document එකක තබා ඇත. මෙය දැනට ඇති 30-team event එකට සරල migration එකකි. MongoDB document limit එක 16 MB බැවින් data වැඩි වුවහොත් collections කිහිපයකට වෙන් කළ යුතුයි.
2. Railway replicas එකක් පමණක් භාවිත කරන්න. FIFO mutex එක process-local වන අතර SSE event broadcaster එකත් process-local ය. Replicas කිහිපයක් දාන්නේ නම් distributed lock/atomic transaction සහ cross-instance event broadcaster අවශ්‍යයි.
3. Admin login එක දැනට එක් shared passcode එකක් මත පදනම් වේ. එය MongoDB තුළ plain text ලෙස නොතබා Railway secret එකක් ලෙස තබයි. වෙන වෙනම admin users add/edit/delete කිරීමේ UI/API එක මෙම migration එකට ඇතුළත් කර නැත.
4. Admin passcode වෙනස් කිරීමට Railway Variables හි `INNOHACK_ADMIN_PASSCODE` update කර redeploy කරන්න.
5. `server/data/store.json` සහ `functions/src/authorizedTeams.ts` public repository එකකට commit නොකරන්න. Seed file එකේ plaintext registration codes අඩංගුයි.
6. `VITE_API_BASE_URL` පමණක් frontend environment variable එකකි. MongoDB URI, pepper, JWT/session secret සහ admin passcode කිසිවිටෙක frontend code එකට දාන්න එපා.
7. MongoDB Atlas backup/export එකක් වරින් වර ගන්න. Free cluster එක production backup policy එකකට සමාන නොවේ.
8. මෙම package එකේ Firebase Cloud Functions/Firestore frontend integration ඉවත් කර Railway API එක තෝරාගෙන ඇත. පරණ Firebase project එකේ data ස්වයංක්‍රීයව delete නොවේ; එය වෙනම පවතී.

---

ගැටලුවක් ඇති වුවහොත් Railway Deploy Logs සහ MongoDB Atlas Network Access / Database Access settings පළමුව පරීක්ෂා කරන්න.
