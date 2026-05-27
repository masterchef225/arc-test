const express = require('express');
const pino = require('pino');

const log = pino();
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  res.json({ ok: true, host: require('os').hostname() });
});

app.get('/health', (_req, res) => res.send('ok'));

app.listen(port, () => log.info(`listening on ${port}`));


