import fs from "fs";

import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { Elysia, redirect, t } from "elysia";
import { randomUUID } from "crypto";
import staticPlugin from "@elysiajs/static";
import { file } from "bun";
import { recordsTable } from "./db";
import { asc, eq } from "drizzle-orm";
import { chdir } from "process";

chdir(import.meta.dir);

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

app.onAfterHandle(async ({ request, cookie, error, redirect }) => {
  if (!request.url.includes("/main")) return;
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

app.get("/main/CoursePlan/CoursePlanEdit", () => {
  let fName;
  const val = Math.random();
  if (val < 0.33 || fs.existsSync(".noerr")) {
    fName = "response/irs.html";
  } else if (val < 0.66) {
    fName = "response/irsError.html";
  } else {
    fName = "response/irsEmpty.html";
  }
  return file(fName);
});

app.post(
  "/main/CoursePlan/CoursePlanSave",
  async ({ body, redirect, user }) => {
    if (!user) return redirect("/");

    await db
      .update(recordsTable)
      .set({
        body: JSON.stringify(body),
        timeElapsed: new Date().getTime() - user.startTime,
      })
      .where(eq(recordsTable.name, user.name));
    return redirect("/main/CoursePlan/CoursePlanDone");
  }
);

app.get("/main/CoursePlan/CoursePlanDone", async ({ user }) => {
  if (!user) return redirect("/");

  const record = await db
    .select()
    .from(recordsTable)
    .where(eq(recordsTable.name, user.name));
  if (record.length == 0) return redirect("/");

  const time = record[0].timeElapsed;
  return `Congrats ${user.name}! Your time is: ${time}ms. Your data is:\n\n${record[0].body}`;
});

app.get("/main/Schedule/Index", () => {
  return file("response/schedule.html");
});

/* ============================================
   From this point is not relevant to mocking
   ============================================ */

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
    .limit(50);

  return (
    "Leaderboard: \n" +
    records
      .map((record, i) => {
        return `${i + 1}. ${record.name} - ${record.timeElapsed}ms`;
      })
      .join("\n")
  );
});

app.listen(3000, () => {
  console.log(`Example app listening at http://localhost:3000`);
});
