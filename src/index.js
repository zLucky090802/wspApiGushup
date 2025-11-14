// src/index.js
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import wspRoutes from './routes/wspRoutes.js';

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

app.use(express.json());

// ✅ servir archivos convertidos y otros estáticos
app.use('/static', express.static(path.join(__dirname, 'public')));

// ✅ tus rutas principales
app.use('/wa', wspRoutes);

app.listen(PORT, () => {
  console.log(`[SERVER] corriendo en puerto: ${PORT}`);
  console.log(`[SERVER] estáticos: http://localhost:${PORT}/static`);
});
