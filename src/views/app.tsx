// The app page. The browser script (src/client/app.ts) draws each screen into <main> from the
// shop's data, which is embedded here so the page shows up ready without a second request.
import { Layout } from './layout';

// Safe to place inside <script>: nothing in it can close the tag.
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export const AppPage = ({ state }: { state: unknown }) => (
  <Layout>
    <header class="top">
      <a class="brand" href="#/">Shop Tracker</a>
      <nav>
        <a href="#/" data-nav="board">Projects</a>
        <a href="#/calendar" data-nav="calendar">Calendar</a>
        <a href="#/tasks" data-nav="tasks">Tasks</a>
        <a href="#/new" data-nav="new">New<span class="widenav"> project</span></a>
        <a href="#/settings" data-nav="settings">Settings</a>
      </nav>
      <div class="bellwrap" id="bellWrap" hidden>
        <button type="button" class="bell" id="bell" aria-haspopup="true" aria-expanded="false" aria-label="New orders">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>
          <span class="count" id="bellCount" hidden></span>
        </button>
        <div class="bellpanel" id="bellPanel" hidden></div>
      </div>
      <span id="syncState"></span>
      <form method="post" action="/logout"><button class="signout">Sign out</button></form>
    </header>
    <main id="view"></main>
    <div id="toast" role="status"></div>
    <script id="initialState" type="application/json" dangerouslySetInnerHTML={{ __html: embed(state) }} />
    <script type="module" src="/app.js"></script>
  </Layout>
);
