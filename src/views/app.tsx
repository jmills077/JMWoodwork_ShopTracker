// The app page. The browser script (src/client/app.ts) draws each screen into <main> from the
// shop's data, which is embedded here so the page shows up ready without a second request.
import { Layout } from './layout';

// Safe to place inside <script>: nothing in it can close the tag.
const embed = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

export const AppPage = ({ state }: { state: unknown }) => (
  <Layout>
    <header class="top">
      <a class="brand" href="#/">Shop Tracker</a>
      {/* On a computer: these links across the top. On a phone they move to the tab bar at the bottom (below). */}
      <nav class="topnav">
        <a href="#/" data-nav="board">Projects</a>
        <a href="#/calendar" data-nav="calendar">Calendar</a>
        <a href="#/tasks" data-nav="tasks shopping">Tasks</a>
        <a href="#/receipts" data-nav="receipts">Receipts</a>
        <a href="#/settings" data-nav="settings">Settings</a>
      </nav>
      <span id="syncState"></span>
      <button type="button" class="hicon find" id="findBtn" aria-label="Find a project" title="Find a project (press /)">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20"/></svg>
      </button>
      <div class="bellwrap" id="bellWrap" hidden>
        <button type="button" class="bell" id="bell" aria-haspopup="true" aria-expanded="false" aria-label="New orders">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>
          <span class="count" id="bellCount" hidden></span>
        </button>
        <div class="bellpanel" id="bellPanel" hidden></div>
      </div>
      <a class="hicon gear" href="#/settings" data-nav="settings" aria-label="Settings">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5L19.4 13ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>
      </a>
      <a class="newbtn" href="#/new" data-nav="new" aria-label="New project"><span aria-hidden="true">+</span><span class="widenav"> New project</span></a>
    </header>
    {/* Phone and home-screen app: the main places, in reach of a thumb. */}
    <nav class="tabbar" aria-label="Main">
      <a href="#/" data-nav="board"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z"/></svg>Projects</a>
      <a href="#/calendar" data-nav="calendar"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v14H4zM4 10h16M8 3v5M16 3v5"/></svg>Calendar</a>
      <a href="#/tasks" data-nav="tasks"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6l2 2 3-3M4 13l2 2 3-3M12 7h8M12 14h8M12 20h8M4 20h4"/></svg>Tasks</a>
      <a href="#/tasks/shopping" data-nav="shopping"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h3l2.4 10.5h10.2L21 7H7M10 19.5a1 1 0 1 0 0 .1M18 19.5a1 1 0 1 0 0 .1"/></svg>Shopping</a>
      <a href="#/receipt" data-nav="receipts"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l1.5-2.5h7L17 8h3v11H4zM12 16.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg>Receipts</a>
    </nav>
    <div class="finder" id="finder" hidden>
      <div class="findbox" role="dialog" aria-label="Find a project">
        <input type="search" id="findInput" placeholder="Find a project, client or quote number" autocomplete="off" enterkeyhint="go" />
        <ul id="findResults"></ul>
      </div>
    </div>
    <main id="view"></main>
    <div id="toast" role="status"></div>
    <script id="initialState" type="application/json" dangerouslySetInnerHTML={{ __html: embed(state) }} />
    <script type="module" src="/app.js"></script>
  </Layout>
);
