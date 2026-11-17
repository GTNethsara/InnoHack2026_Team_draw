import { localPortalService } from './localPortalService';

// The same typed API client is used locally (Vite proxy) and in production (Railway URL).
export const portalApi = localPortalService;
export const BACKEND_MODE_LABEL = 'Railway Node.js API + MongoDB Atlas';
