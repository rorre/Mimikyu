import fs from "fs";

import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { Elysia, error, redirect, t } from "elysia";
import { randomUUID } from "crypto";
import staticPlugin from "@elysiajs/static";
import { file } from "bun";
import { recordsTable } from "./db";
import { asc, eq } from "drizzle-orm";
import { chdir } from "process";

try {
  chdir(import.meta.dir);
} catch {}

/* ============================================ */
/* Database setup */
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(turso);

/* ============================================ */

const app = new Elysia({
  cookie: {
    secrets: Bun.env.SECRET,
    sign: ["run"],
  },
})
  .use(staticPlugin({ prefix: "/" }))
  .derive(({ cookie }) => {
    const cookieStr = cookie["run"].value ?? "";
    if (cookieStr === "") return { user: null };

    const userData = JSON.parse(atob(cookieStr));
    return {
      user: userData as unknown as {
        name: string;
        startTime: number;
      },
    };
  });

interface FakeData {
  isError: boolean;
  isWrongStatus: boolean;
  isReauth: boolean;
  fileId?: string;
  delayTime: number;
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function consoleLogger(req: Request, data: FakeData) {
  let tokens;
  // Disable behavior changes
  if (fs.existsSync(".noerr")) {
    tokens = [`[${req.method}]`, req.url, "Normal"];
  } else {
    tokens = [
      `[${req.method}]`,
      req.url,
      data.isError ? "FakedError" : "Normal",
      data.isWrongStatus ? "WrongStatus" : "NormalStatus",
      data.fileId ?? "Not an error",
      data.isReauth ? "ReAuth" : "Normal",
      Math.round(data.delayTime).toString() + "ms",
    ];
  }

  console.log(tokens.join(" | "));
}

async function simulate(
  request: Request,
  cookie: Record<string, any>,
  error: Function,
  redirect: Function
) {
  const data: FakeData = {
    isError: false,
    isWrongStatus: false,
    isReauth: false,
    delayTime: 0,
  };

  if (fs.existsSync(".noerr")) {
    return [null, data] as const;
  }

  // Simulates siak server + indihome
  let delayTime = Math.random() * 5000;
  await sleep(delayTime);
  data.delayTime = delayTime;

  // Simulates overload error
  let shouldContinue = Math.random() > 0.8;
  data.isError = !shouldContinue;

  if (!shouldContinue) {
    let isWrongStatus = Math.random() > 0.5;
    data.isWrongStatus = isWrongStatus;

    let fileId = `siakOverload${Math.round(Math.random()).toString()}.html`;
    data.fileId = fileId;
    return [
      error(isWrongStatus ? 200 : 502, file("response/" + fileId)),
      data,
    ] as const;
  }

  // Simulates de-auth error
  if (request.url.indexOf("/main/Authentication/") == -1) {
    let shouldReAuth = Math.random() > 0.5;
    if (!cookie.Mojavi) shouldReAuth = true;
    data.isReauth = shouldReAuth;

    if (shouldReAuth) {
      return [redirect("/main/Authentication/"), data] as const;
    }
  }

  return [null, data] as const;
}

app.onBeforeHandle(async ({ request, cookie, error, redirect }) => {
  const urlWithoutQueryOrHash = request.url.split(/[?#]/)[0];
  if (
    !urlWithoutQueryOrHash.includes("/main/") ||
    urlWithoutQueryOrHash.includes("/main-www/")
  )
    return;

  const [res, data] = await simulate(request, cookie, error, redirect);
  consoleLogger(request, data);

  if (res) return res;
});

app.onBeforeHandle(({ request, cookie }) => {
  if (request.url.includes("/main/") && !cookie["run"].value) {
    return redirect("/");
  }

  if (
    request.url.includes("/main/") &&
    !request.url.includes("Authentication") &&
    (!cookie["Mojavi"].value || !cookie["siakng_cc"].value)
  ) {
    return redirect("/main/Authentication/");
  }
});

app.get("/main/Authentication/", () => {
  return file("response/auth.html");
});

app.post("/main/Authentication/Index", ({ cookie }) => {
  let mojaviUid = randomUUID();

  cookie["Mojavi"].value = mojaviUid;
  cookie["siakng_cc"].value = "noOneCaresAboutThisOneLOL";
  return new Response(file("response/authDone.html"));
});

app.get("/main/Authentication/ChangeRole", ({ redirect }) => {
  return redirect("/main/CoursePlan/CoursePlanEdit");
});

app.get("/main/CoursePlan/CoursePlanEdit", async ({ cookie }) => {
  let fName;
  const val = Math.random();
  if (val < 0.33 || fs.existsSync(".noerr")) {
    fName = "response/irs.html";
  } else if (val < 0.66) {
    fName = "response/irsError.html";
  } else {
    fName = "response/irsEmpty.html";
  }

  if (cookie["X-BOT"].value) {
    return file(fName);
  }

  const irs = await file(fName).text();

  return new Response(
    irs.replaceAll(
      "<!--CAPTCHA-->",
      `<div class="cf-turnstile" data-sitekey="${Bun.env
        .CAPTCHA_SITE_KEY!}"></div><br/>`
    ),
    {
      headers: {
        "content-type": "text/html",
      },
    }
  );
});

app.post(
  "/main/CoursePlan/CoursePlanSave",
  async ({ body, redirect, user, cookie, request, server }) => {
    if (!user) return redirect("/");

    const isBot = cookie["X-BOT"].value != undefined;
    if (!isBot) {
      const response = await verifyCloudflare(
        // @ts-ignore
        body["cf-turnstile-response"],
        server?.requestIP(request)?.address ?? "127.0.0.1"
      );

      if (!response.success) {
        return error("Bad Request", "Cloudflare no likey :/");
      }
    }

    const existing = await db
      .select()
      .from(recordsTable)
      .where(eq(recordsTable.name, user.name));

    const delta = new Date().getTime() - user.startTime;
    const isBetter = (existing[0]?.timeElapsed ?? delta + 1) > delta;

    await db
      .update(recordsTable)
      .set({
        body: JSON.stringify(body),
        timeElapsed: delta,
        isBot: isBot ? 1 : 0,
      })
      .where(eq(recordsTable.name, user.name));
    return redirect(
      `/main/CoursePlan/CoursePlanDone?better=${isBetter ? 1 : 0}`
    );
  }
);

app.get("/main/CoursePlan/CoursePlanDone", async ({ user, query }) => {
  if (!user) return redirect("/");

  const record = await db
    .select()
    .from(recordsTable)
    .where(eq(recordsTable.name, user.name));
  if (record.length == 0) return redirect("/");

  const time = record[0].timeElapsed;
  const congratsPage = await file("response/finish.html").text();
  let response = congratsPage.replace("XXXX", time?.toString() ?? "?");

  if (query.better == "0") {
    response = response.replace(
      "You have finished in",
      "Unfortunately, you did not beat your time in"
    );
  }

  return new Response(response, {
    headers: { "content-type": "text/html" },
  });
});

/* ============================================
   From this point is not relevant to mocking
   ============================================ */

async function verifyCloudflare(token: string, ip: string) {
  const url = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  const result = await fetch(url, {
    body: JSON.stringify({
      secret: Bun.env.CAPTCHA_SECRET_KEY!,
      response: token,
      remoteip: ip,
    }),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  return await result.json();
}

app.get("/", () => {
  return file("response/index.html");
});

app.post(
  "/start",
  async ({ body, cookie }) => {
    const result = await db
      .select()
      .from(recordsTable)
      .where(eq(recordsTable.name, body.name));
    if (result.length == 0) {
      const data = {
        name: body.name,
        password: await Bun.password.hash(body.password),
      };
      await db.insert(recordsTable).values(data);

      result.push({
        ...data,
        id: -1,
        body: null,
        timeElapsed: null,
        isBot: 0,
      });
    }

    const record = result[0];
    if (!(await Bun.password.verify(body.password, record.password))) {
      return new Response("Wrong password", { status: 400 });
    }

    const value = { name: body.name, startTime: new Date().getTime() };

    cookie["run"].set({
      value: btoa(JSON.stringify(value)),
    });
    return redirect("/main/Authentication/");
  },
  {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      password: t.String({ minLength: 8 }),
    }),
  }
);

app.get("/leaderboard", async () => {
  const records = await db
    .select()
    .from(recordsTable)
    .orderBy(asc(recordsTable.timeElapsed))
    .where(eq(recordsTable.isBot, 0))
    .limit(50);

  const leaderboardPage = await file("response/leaderboard.html").text();
  const response = leaderboardPage.replace(
    "<!--LEADERBOARD-->",
    records
      .map((record, i) => {
        return `<tr class="hover:bg-gray-100">
          <td class="py-2 px-4 border-b">${i + 1}</td>
          <td class="py-2 px-4 border-b">${record.name}</td>
          <td class="py-2 px-4 border-b">${record.timeElapsed}</td>
        </tr>`;
      })
      .join("\n")
  );

  return new Response(response, {
    headers: { "content-type": "text/html" },
  });
});

app.get("/leaderboard/bot", async () => {
  const records = await db
    .select()
    .from(recordsTable)
    .orderBy(asc(recordsTable.timeElapsed))
    .where(eq(recordsTable.isBot, 1))
    .limit(50);

  const leaderboardPage = await file("response/leaderboard.html").text();
  const response = leaderboardPage.replace(
    "<!--LEADERBOARD-->",
    records
      .map((record, i) => {
        return `<tr class="hover:bg-gray-100">
          <td class="py-2 px-4 border-b">${i + 1}</td>
          <td class="py-2 px-4 border-b">${record.name}</td>
          <td class="py-2 px-4 border-b">${record.timeElapsed}</td>
        </tr>`;
      })
      .join("\n")
  );

  return new Response(response, {
    headers: { "content-type": "text/html" },
  });
});

app.listen(3000, () => {
  console.log(`Example app listening at http://localhost:3000`);
});
