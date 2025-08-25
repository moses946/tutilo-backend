const express = require('express');
const app = express();
const PORT = 3000;

// Middleware (optional example)
app.use(express.json());

// Basic route
app.get('/', (req, res) => {
  res.send('Hello, Express!');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
