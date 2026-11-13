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
      <span id="syncState"></span>
      <form method="post" action="/logout"><button class="signout">Sign out</button></form>
    </header>
    <main id="view"></main>
    <div id="toast" role="status"></div>
    <script id="initialState" type="application/json" dangerouslySetInnerHTML={{ __html: embed(state) }} />
    <script type="module" src="/app.js"></script>
  </Layout>
);
