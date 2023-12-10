import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
    return {
        server: {
            host: "127.0.0.1",
            port: 3000,
            strictPort: true
        }
    }
});