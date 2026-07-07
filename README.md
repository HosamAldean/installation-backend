Installation App - Backend (scaffold)


## Quick start
1. Copy files into `backend/` folder.
2. Create `.env` from `.env.example` and set real secrets.
3. Install deps:


```bash
npm install
```


4. Initialize DB & seed admin (dev only):


```bash
node scripts/init-db.js
```


5. Run dev server:


```bash
npm run dev
```


6. API endpoints:
- `POST /api/auth/signup` - create user (dev)
- `POST /api/auth/login` - login -> returns `{ token }`
- `GET /api/items` - list items (requires Authorization: Bearer <token>)
- `GET /api/users/me` - current user




// End of scaffold