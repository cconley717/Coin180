import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Parse JSON request bodies
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Mount all routes
app.use('/', routes);

export default app;
