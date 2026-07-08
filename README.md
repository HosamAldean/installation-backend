# Installation & Warehouse Tracking — Backend

Node.js/Express HTTPS API backing the installation-tracking and warehouse
apps: follow-up order tracking, installation requests/steps, teams, Main
Stock (warehouse shipping), and the Glass fabrication-order module
(orders → item specs → receive-into-stock → billing). Consumed by a
[Vite/React frontend](https://github.com/HosamAldean/installation) and an
Expo/React Native mobile app.

## Requirements

- Node.js
- MySQL (primary data store) and access to the relevant SQL Server
  instances (Main Stock, Glass, Proj, StockHouse — see `config/db.js`)
- [mkcert](https://github.com/FiloSottile/mkcert)-generated
  `localhost+1-key.pem` / `localhost+1.pem` in this directory (the server
  runs HTTPS locally)
- A `.env` file (see **Environment** below)

## Run

```bash
npm install
npm run dev     # nodemon watch + node index.js
npm start       # node index.js (production)
```

Starts HTTPS on port **4000**, with an HTTP→HTTPS redirect on port 4001.

## Architecture

### Dual-database design

`config/db.js` exports three Sequelize (MySQL) instances and a SQL Server
helper:

- `sequelize` — primary MySQL, latin1 charset with a UTF-8 type-cast
  workaround for legacy data
- `sequelize2` / `sequelize3` — secondary MySQL (`IIT_Petra` schema)
- `getSqlPool(key)` — one pooled connection per SQL Server database,
  connecting on demand to `erp`, `proj`, `stockhouse`, `glass`, or
  `minstock`

MySQL models live in `models/` and are registered in `models/index.js`
(imported once at startup to define all associations). SQL Server queries
are raw `mssql` calls inside route handlers.

### Real-time updates

The backend polls MySQL every 3 seconds and pushes Server-Sent Events via
`routes/sse.js` when `instTeamCheckpoints`, `instOrderSteps`, or
`instTeamLocations` change — the frontend's live dashboards and field-news
feed subscribe to this stream.

### Auth

JWT in HTTP-only cookies; `middleware/auth.js` validates tokens on
protected routes and enforces role checks (`user` / `manager` / `admin` /
`warehouse`).

## Environment

Key variables (see `config/db.js` for the full list):

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME` | Primary MySQL |
| `MSSQL1_*` | ERP SQL Server |
| `MSSQL2_SERVER`, `MSSQL2_*_DB` | Proj/StockHouse/Glass/MinStock SQL Server databases (all on the same server instance) |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Auth token signing |

Never commit `.env` — it's gitignored, along with `*.pem` certs and
`uploads/` (user-uploaded photos).
