# 🎴 CENTURY - Web-Based Multiplayer Card Game

CENTURY is a fast-paced, strategic multiplayer card game built for the web. Players compete to reduce the point value of the cards in their hand to 6 or less, strategically calling "SHOW" at the right moment. Reach 100 points and you are eliminated. The last player standing wins!

## 🚀 Features

*   **Real-time Multiplayer:** Play with 2 to 8 friends simultaneously using Socket.io.
*   **Server-Authoritative Logic:** All game rules, validations, and scoring are handled securely on the backend to prevent cheating.
*   **Hidden Hands:** Players can only see their own cards. Opponents' cards remain hidden until a SHOW is called.
*   **Private Rooms:** Create a private room and share the 5-letter room code with your friends.
*   **Responsive Design:** Fully playable on both desktop and mobile browsers.
*   **Reconnection Support:** If a player accidentally refreshes the page, they are automatically reconnected to their active game session.

## 🛠️ Tech Stack (MERN)

This project is built using the MERN stack (with Socket.io for real-time communication):

*   **Frontend:** React.js, Socket.io-client, Custom CSS
*   **Backend:** Node.js, Express.js, Socket.io
*   **Database:** *(Optional / In-Memory)* Currently, rooms and game states are stored in server memory (RAM) for fast, zero-latency gameplay. 
*   **Game Engine:** Pure Vanilla JavaScript (`game.js` & `cards.js`) for 100% testable and dependency-free logic.

## 📁 Folder Structure

```text
century-game/
├── backend/
│   ├── lib/
│   │   ├── cards.js       # Card values and combination validation rules
│   │   └── game.js        # Core game engine (turns, scoring, SHOW logic)
│   ├── server.js          # Express server and Socket.io setup
│   └── package.json
└── frontend/
    ├── public/
    │   └── index.html
    ├── src/
    │   ├── App.js         # Main React UI and Socket connection
    │   ├── index.css      # Game styling
    │   └── index.js
    └── package.json
