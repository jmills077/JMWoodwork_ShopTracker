import { Layout } from './layout';

export const LoginPage = ({ error }: { error?: string }) => (
  <Layout title="Sign in · Shop Tracker">
    <header class="top"><span class="brand">Shop Tracker</span></header>
    <main>
      <form class="card login" method="post" action="/login">
        <h1>Sign in</h1>
        {error && <p class="note err">{error}</p>}
        <label class="f"><span>Shop password</span>
          <input type="password" name="password" autocomplete="current-password" required autofocus />
        </label>
        <p><button class="btn primary" type="submit">Sign in</button></p>
      </form>
    </main>
  </Layout>
);

/** Shown instead of the app when the server is missing its password. */
export const SetupPage = () => (
  <Layout title="Setup needed · Shop Tracker">
    <header class="top"><span class="brand">Shop Tracker</span></header>
    <main>
      <div class="card login">
        <h1>Setup needed</h1>
        <p>No sign-in password is set, so the app stays locked. Set the <code>APP_PASSWORD</code> secret:</p>
        <p>Locally, copy <code>.dev.vars.example</code> to <code>.dev.vars</code> and restart <code>npm run dev</code>.
          On Cloudflare, run <code>npx wrangler secret put APP_PASSWORD</code>.</p>
      </div>
    </main>
  </Layout>
);
