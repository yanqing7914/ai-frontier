import axios from 'axios';
import { resolveApiBaseUrl } from './api-base-url';
import { validateApiResponse } from './validate-api-response';
import { getDevelopmentAdminHeaders } from './admin-auth';

const developmentAdminHeaders = getDevelopmentAdminHeaders(
  import.meta.env.DEV,
  import.meta.env.VITE_LOCAL_DEV === 'true',
  import.meta.env.VITE_ADMIN_API_TOKEN,
);

export const http = axios.create({
  baseURL: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL),
  headers: {
    'Content-Type': 'application/json',
    ...developmentAdminHeaders,
  },
});

// A missing dev proxy can make Vite return the SPA HTML with HTTP 200. Fail
// loudly instead of letting callers treat that string as an empty API payload.
http.interceptors.response.use((response) => {
  const contentType = response.headers?.['content-type'] || '';
  validateApiResponse(response.data, contentType);
  return response;
});
