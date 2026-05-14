import { WebSocket as _WS } from "ws";
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = _WS;
}
import { Client } from 'revolt.js';
import { CONFIG } from './config.js';

const c = new Client();
c.on('ready', () => {
    console.log('Ready!');
    console.log('client.api.config.headers:', c.api.config.headers);
    process.exit(0);
});
c.loginBot(CONFIG.token);
setTimeout(() => process.exit(1), 5000);
