import { render } from "preact";
import { App } from "./app.tsx";
import { clearNotificationsOnView, registerServiceWorker } from "./notifications.ts";
import "./styles.css";

render(<App />, document.getElementById("app") as HTMLElement);
registerServiceWorker();
clearNotificationsOnView();
