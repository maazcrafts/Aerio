# ⚡ Aerio

A modern real-time messaging platform built with a focus on privacy, performance, and a clean user experience.

🌐 **Live:** https://aerio-delta.vercel.app

---

## Overview

Aerio is a full-stack chat application that allows users to communicate in real time through a modern web and Android interface.

The project uses end-to-end encryption for private messaging, real-time communication through Socket.IO, and a multi-device key architecture.

---

## Features

- 💬 Real-time messaging
- 🔐 End-to-end encrypted private chats
- 📱 Android application support
- 🌐 Responsive web application
- 👤 User authentication
- 🟢 Online status
- 🔔 Push notification support
- 👥 Direct messaging and groups
- 🔑 Device-based encryption keys
- ⚡ Real-time updates with Socket.IO
- 🎨 Modern dark user interface

---

## Tech Stack

### Frontend

- React
- Vite
- JavaScript
- Socket.IO Client
- Tailwind / Custom CSS

### Backend

- Node.js
- Express.js
- Socket.IO
- PostgreSQL

### Mobile

- Capacitor
- Android

### Deployment

- Vercel — Frontend
- Render — Backend

---

## Project Structure

```text
Aerio/
│
├── frontend/          # React web application
│   ├── src/
│   ├── components/
│   └── crypto.js
│
├── backend/           # Node.js API and Socket.IO server
│   ├── server.js
│   └── database/
│
├── android/           # Capacitor Android project
│
├── package.json
└── capacitor.config.json


Getting Started
Clone the repository
git clone https://github.com/maazcrafts/Aerio.git
cd Aerio

Frontend Setup
cd frontend
npm install
npm run dev

To create a production build:

npm run build
Backend Setup
cd backend
npm install
node server.js

Create a .env file and add the required environment variables:

DATABASE_URL=your_database_url
JWT_SECRET=your_secret

Android Build

After building the frontend:

cd frontend
npm run build
npx cap sync android

Then open the Android project:

npx cap open android

Build and run the application using Android Studio.

Security

Aerio uses a client-side encryption architecture for private messaging.

Encryption keys are managed per device, allowing the application to support multiple devices while keeping private messages encrypted.

Sensitive cryptographic material such as private keys and plaintext messages is not intended to be exposed through server-side message handling.

Development

This project is actively being developed and improved.

Current areas of development include:

Improving multi-device messaging
Encryption reliability
Push notifications
Message delivery improvements
UI/UX improvements
Performance optimization
Author

Maaz Khan

GitHub: https://github.com/maazcrafts

<p align="center"> Built by Maaz 🚀 </p> ```
```
