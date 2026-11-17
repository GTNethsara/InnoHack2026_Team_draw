# INNOHACK Team Leader Portal

React + Vite frontend with a Node.js/Express API and MongoDB Atlas persistence.

## Deployment

Read **[DEPLOYMENT_SI.md](./DEPLOYMENT_SI.md)** for the complete Sinhala guide to:

- MongoDB Atlas Free Cluster setup and one-time JSON migration
- Railway backend deployment and environment variables
- Vercel frontend deployment and CORS configuration
- Production checks, backup and security notes

## Local development

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Keep the private `server/data/store.json` file available locally.
4. Run `npm run dev:full`.
5. Open the Vite URL shown in the terminal (normally `http://localhost:5173`).

Local development uses the existing JSON store when `MONGODB_URI` is not set. Production refuses to start unless MongoDB is configured and the initial state has been migrated.

## Important security notes

- Never commit `.env`, `server/data/*.json`, or `functions/src/authorizedTeams.ts`.
- The authorized-team source file is a private one-time migration input. The deployed Railway API does not import it.
- Production requires `MONGODB_URI`, `INNOHACK_AUTH_PEPPER`, `INNOHACK_SESSION_SECRET`, and `INNOHACK_ADMIN_PASSCODE`.
- Use one Railway replica with the current in-process FIFO mutex and SSE broadcaster. Multi-replica deployment needs distributed locking and cross-instance event broadcasting first.
- The current admin login is a single shared passcode configured as a Railway secret. Per-admin account CRUD is not part of this migration.
