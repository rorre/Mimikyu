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

interface UserData {
  sessionId: string;
  name: string;
  startTime: number;
  isBot: boolean;
}

/* ============================================ */
/* const */
const MOCK_CONFIG = {
  bot: {
    delayTime: 5000,
    overloadProbability: 0.8,
    wrongResponseCodeProbability: 0.5,
    deauthProbability: 0.5,
    successIrsProbability: 0.33,
  },
  human: {
    delayTime: 5000,
    overloadProbability: 0.5,
    wrongResponseCodeProbability: 0.2,
    deauthProbability: 0.2,
    successIrsProbability: 0.5,
  },
};

/* ============================================ */
/* Database setup */
const turso = createClient({
  url: Bun.env.TURSO_DATABASE_URL!,
  authToken: Bun.env.TURSO_AUTH_TOKEN,
});

const db = drizzle(turso);

/* ============================================ */

const app = new Elysia({
  cookie: {
    secrets: Bun.env.SECRET,
    sign: ["run", "Mojavi"],
  },
})
  .use(staticPlugin({ prefix: "/" }))
  .derive(({ cookie }) => {
    const cookieStr = cookie["run"].value ?? "";
    if (cookieStr === "") return { user: null };

    const userData = JSON.parse(atob(cookieStr));
    return {
      user: userData as unknown as UserData,
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
  redirect: Function,
  user: UserData
) {
  const config = user.isBot ? MOCK_CONFIG.bot : MOCK_CONFIG.human;
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
  let delayTime = Math.random() * config.delayTime;
  await sleep(delayTime);
  data.delayTime = delayTime;

  // Simulates overload error
  let shouldContinue = Math.random() > config.deauthProbability;
  data.isError = !shouldContinue;

  if (!shouldContinue) {
    let isWrongStatus = Math.random() > config.wrongResponseCodeProbability;
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
    let shouldReAuth = Math.random() > config.deauthProbability;
    if (!cookie.Mojavi) shouldReAuth = true;
    data.isReauth = shouldReAuth;

    if (shouldReAuth) {
      return [redirect("/main/Authentication/"), data] as const;
    }
  }

  return [null, data] as const;
}

app.onBeforeHandle(async ({ request, cookie, error, redirect, user }) => {
  const urlWithoutQueryOrHash = request.url.split(/[?#]/)[0];
  if (
    !urlWithoutQueryOrHash.includes("/main/") ||
    urlWithoutQueryOrHash.includes("/main-www/") ||
    !user
  )
    return;

  const [res, data] = await simulate(request, cookie, error, redirect, user);
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

app.post("/main/Authentication/Index", ({ cookie, user }) => {
  cookie["Mojavi"].value = user?.sessionId;
  cookie["siakng_cc"].value = "noOneCaresAboutThisOneLOL";
  return new Response(file("response/authDone.html"));
});

app.get("/main/Authentication/ChangeRole", ({ redirect, user, cookie }) => {
  if (!user || user.sessionId != cookie["Mojavi"].value) {
    return error("Unauthorized", "why are you here");
  }

  return redirect("/main/CoursePlan/CoursePlanEdit");
});

app.get("/main/CoursePlan/CoursePlanEdit", async ({ cookie, user }) => {
  if (!user || user.sessionId != cookie["Mojavi"].value) {
    return error("Unauthorized", "why are you here");
  }

  const prob = user.isBot
    ? MOCK_CONFIG.bot.successIrsProbability
    : MOCK_CONFIG.human.successIrsProbability;

  let fName;
  const val = Math.random();
  if (val < prob || fs.existsSync(".noerr")) {
    fName = "response/irs.html";
  } else if (val < (1 - prob) / 2) {
    fName = "response/irsError.html";
  } else {
    fName = "response/irsEmpty.html";
  }

  if (user?.isBot) {
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
    if (user.sessionId != cookie["Mojavi"].value) {
      return error("Unauthorized", "why are you here");
    }

    const isBot = user.isBot;
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
        isBot: body.isBotRun == "on" ? 1 : 0,
      });
    }

    const record = result[0];
    if (!(await Bun.password.verify(body.password, record.password))) {
      return new Response("Wrong password", { status: 400 });
    }

    const value: UserData = {
      sessionId: randomUUID(),
      name: body.name,
      startTime: new Date().getTime(),
      isBot: body.isBotRun == "on",
    };

    cookie["run"].set({
      value: btoa(JSON.stringify(value)),
    });
    return redirect("/main/Authentication/");
  },
  {
    body: t.Object({
      name: t.String({ minLength: 1 }),
      password: t.String({ minLength: 8 }),
      isBotRun: t.Optional(t.String()),
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
