import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Allow requests from any host — needed for ngrok/tunneling during dev.
    allowedHosts: true,
  },
});
