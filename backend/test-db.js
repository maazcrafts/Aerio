const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Client } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in backend/.env');
}

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

client
  .connect()
  .then(() => {
    console.log("✅ Connected successfully!");
    return client.end();
  })
  .catch((err) => {
    console.error(err);
  });
