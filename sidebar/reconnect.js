// The sidebar connects once (`port` in sidebar.js), and every script here uses that
// one port. If the background part is not there yet when the page loads (Firefox
// starting), or goes away and comes back, the port is dead and the list would stay
// empty or stale, with every click lost, until you closed and opened the sidebar.
//
// Loading the page again is the whole cure: it connects anew, and `port` can stay a
// const for everyone. With growing waits and only a few tries, since something else
// may be wrong; those are counted in sessionStorage, the one thing a reload leaves.
// A view that arrives shows the connection works, so the count starts over. Nothing is
// shown meanwhile. After the last try the page stays as it is, still connected if it
// is: a view that arrives very late is drawn all the same.
{
  const NO_VIEW_MS = 2000; // from hello: the background answers in a fraction of that
  const WAITS_MS = [250, 1000, 4000, 15000];
  const COUNT = "tidierReconnects";

  // Without sessionStorage the tries cannot be counted, and a page that reloads itself
  // without counting would never stop: then it does not try at all.
  const count = () => { try { return Number(sessionStorage.getItem(COUNT)) || 0; } catch (err) { return Infinity; } };
  const setCount = n => { try { if (n) sessionStorage.setItem(COUNT, String(n)); else sessionStorage.removeItem(COUNT); } catch (err) { /* see count */ } };

  let reload = null;
  const again = () => {
    clearTimeout(noView);
    const tries = count();
    if (reload !== null || tries >= WAITS_MS.length) return;
    setCount(tries + 1);
    reload = setTimeout(() => location.reload(), WAITS_MS[tries]);
  };
  // A busy machine gets more time at each try: reloading sooner would only add to it.
  const noView = setTimeout(again, NO_VIEW_MS * Math.min(count() + 1, WAITS_MS.length));
  port.onDisconnect.addListener(again);
  port.onMessage.addListener(() => {
    clearTimeout(noView);
    clearTimeout(reload);
    reload = null;
    setCount(0);
  });
}
