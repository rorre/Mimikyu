import fs from "fs";

import { Elysia, file } from "elysia";
import { randomUUID } from "crypto";
import staticPlugin from "@elysiajs/static";

const app = new Elysia().use(staticPlugin({ prefix: "/" }));

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
  const [res, data] = await simulate(request, cookie, error, redirect);
  consoleLogger(request, data);

  if (res) return res;
});

app.get("/main/Authentication/", () => {
  return file("response/auth.html");
});

app.post("/main/Authentication/Index", ({ cookie }) => {
  let mojaviUid = randomUUID();
  cookie["Mojavi"].value = mojaviUid;
  cookie["siakng_cc"].value = "noOneCaresAboutThisOneLOL";
  return file("response/authDone.html");
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

app.post("/main/CoursePlan/CoursePlanSave", ({ body, redirect }) => {
  console.log("Body:");
  console.log(body);
  return redirect("/main/CoursePlan/CoursePlanDone");
});

app.get("/main/CoursePlan/CoursePlanDone", () => {
  return "yee";
});

app.get("/main/Schedule/Index", () => {
  return file("response/schedule.html");
});

app.get("/", () => {
  return "Hello World!";
});

app.listen(3000, () => {
  console.log(`Example app listening at http://localhost:3000`);
});
