// Sign-in with a single shop password (the APP_PASSWORD secret). A signed-in browser holds a
// cookie carrying its expiry and a signature made with the password, so changing the password
// signs every device out.
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { App } from '../env';

const COOKIE = 'shop_session';
const SESSION_DAYS = 30;

async function sign(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compares the two values' signatures, so the time taken says nothing about the password.
export async function passwordMatches(password: string, attempt: string) {
  const [a, b] = await Promise.all([sign(password, `pw:${password}`), sign(password, `pw:${attempt}`)]);
  return a === b;
}

export async function isSignedIn(c: Context<App>) {
  const password = c.env.APP_PASSWORD, cookie = getCookie(c, COOKIE);
  if (!password || !cookie) return false;
  const [expires, mac] = cookie.split('.');
  return Number(expires) > Date.now() && mac === await sign(password, `session:${expires}`);
}

export async function startSession(c: Context<App>) {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  setCookie(c, COOKIE, `${expires}.${await sign(c.env.APP_PASSWORD!, `session:${expires}`)}`, {
    path: '/', httpOnly: true, sameSite: 'Lax', secure: new URL(c.req.url).protocol === 'https:', maxAge: SESSION_DAYS * 86400,
  });
}

export const endSession = (c: Context<App>) => deleteCookie(c, COOKIE, { path: '/' });
