import { defineConfig } from 'vite';
export default defineConfig({build:{outDir:'dist',emptyOutDir:true},server:{proxy:{'/api':'http://127.0.0.1:3102','/dev':'http://127.0.0.1:3102','/.well-known':'http://127.0.0.1:3102','/authorize':'http://127.0.0.1:3102','/token':'http://127.0.0.1:3102','/mcp':'http://127.0.0.1:3102'}}});
