import { expect, test } from '@playwright/test';

const issue = (number: number, title: string) => ({
  number,
  node_id: `I_${number}`,
  title,
  body: 'Body text',
  state: 'open',
  labels: [],
  assignees: [],
  html_url: `https://github.com/acme/repo/issues/${number}`,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
});

let releasePost: () => void;
let postStarted: Promise<void>;
let postMode: 'delayed-success' | 'immediate-success' | 'validation';
let issuesMode: 'success' | 'unauthorized' | 'delayed-stale';
let repositoriesMode: 'single' | 'partial';
let releaseIssueGet: () => void;
let issueGetStarted: Promise<void>;

test.beforeEach(async ({ page }) => {
  postMode = 'delayed-success';
  issuesMode = 'success';
  repositoriesMode = 'single';
  let resolveStarted: () => void;
  postStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const postGate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  let resolveIssueGetStarted: () => void;
  issueGetStarted = new Promise<void>((resolve) => {
    resolveIssueGetStarted = resolve;
  });
  const issueGetGate = new Promise<void>((resolve) => {
    releaseIssueGet = resolve;
  });

  await page.addInitScript(() =>
    sessionStorage.setItem('kitsuflow.github.access-token', 'e2e-prod-token'),
  );
  await page.route('https://api.github.com/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/user')
      return route.fulfill({
        json: {
          id: 1001,
          login: 'prod-fox',
          name: 'Prod Fox',
          avatar_url: 'https://avatars.githubusercontent.com/u/1001?v=4',
        },
      });
    if (url.pathname === '/user/installations')
      return route.fulfill({
        json: { total_count: 1, installations: [{ id: 9, account: { login: 'acme' } }] },
      });
    if (url.pathname === '/user/installations/9/repositories')
      return route.fulfill({
        json: {
          total_count: 1,
          repositories: [
            {
              id: 2,
              full_name: 'acme/repo',
              name: 'repo',
              private: false,
              owner: { login: 'acme' },
              permissions: { pull: true, push: true },
            },
            ...(repositoriesMode === 'partial'
              ? [
                  {
                    id: 3,
                    full_name: 'acme/broken',
                    name: 'broken',
                    private: false,
                    owner: { login: 'acme' },
                    permissions: { pull: true, push: true },
                  },
                ]
              : []),
          ],
        },
      });
    if (url.pathname === '/repos/acme/repo/issues' && method === 'GET') {
      if (issuesMode === 'unauthorized')
        return route.fulfill({ status: 401, json: { message: 'Bad credentials' } });
      if (issuesMode === 'delayed-stale') {
        resolveIssueGetStarted!();
        await issueGetGate;
      }
      return route.fulfill({ json: [issue(10, 'Production Issue 10')] });
    }
    if (url.pathname === '/repos/acme/broken/issues' && method === 'GET')
      return route.fulfill({ status: 404, json: { message: 'Not Found' } });
    if (url.pathname === '/repos/acme/repo/issues' && method === 'POST') {
      resolveStarted!();
      if (postMode === 'validation')
        return route.fulfill({ status: 422, json: { message: 'Validation Failed' } });
      if (postMode === 'delayed-success') await postGate;
      const body = route.request().postDataJSON() as { title?: string };
      return route.fulfill({ status: 201, json: issue(11, body.title || 'Created Issue') });
    }
    if (url.pathname === '/repos/acme/repo/labels') return route.fulfill({ json: [] });
    if (url.pathname === '/repos/acme/repo/assignees') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { message: `Unhandled ${method} ${url.pathname}` } });
  });
});

test('real production dist works on Pages subpath with PWA persistence and delayed pending POST', async ({
  page,
  request,
  baseURL,
}) => {
  const badResponses: string[] = [];
  const rootAssetRequests: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(baseURL!).origin && response.status() >= 400)
      badResponses.push(`${response.status()} ${url.pathname}`);
  });
  page.on('request', (requestEvent) => {
    const url = new URL(requestEvent.url());
    if (url.origin === new URL(baseURL!).origin && url.pathname.startsWith('/assets/'))
      rootAssetRequests.push(url.pathname);
  });

  await page.goto('./#all');
  await expect(page.getByText('Prod Fox')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Все задачи' })).toBeVisible();
  expect(page.url()).toContain('/KitsuFlow/#all');
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(csp).toContain('https://oauth-proxy.test');
  expect(csp).not.toContain('workers.dev');

  const resourceUrls = await page
    .locator('script[src], link[rel="stylesheet"]')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          new URL(node.getAttribute('src') || node.getAttribute('href') || '', document.baseURI)
            .href,
      ),
    );
  expect(resourceUrls.length).toBeGreaterThan(0);
  expect(resourceUrls.every((url) => new URL(url).pathname.startsWith('/KitsuFlow/'))).toBe(true);
  expect(rootAssetRequests).toEqual([]);

  const favicon = await request.get(new URL('app-icon.svg', baseURL!).toString());
  expect(favicon.ok()).toBe(true);
  const manifest = await page.evaluate(async () => {
    const href = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href;
    if (!href) throw new Error('manifest link missing');
    return (await fetch(href)).json() as Promise<{ start_url: string; scope: string }>;
  });
  expect(manifest.start_url).toBe('/KitsuFlow/');
  expect(manifest.scope).toBe('/KitsuFlow/');
  const workerScope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(workerScope).toBe(new URL('/KitsuFlow/', baseURL!).toString());
  const unregisterWorkerForMockedReload = () =>
    page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    });

  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Persistent Local Note');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByText('Persistent Local Note')).toBeVisible();
  // Playwright page.route cannot intercept requests initiated by an active Service Worker.
  // Registration/scope were asserted above; unregister only for deterministic mocked reload.
  await unregisterWorkerForMockedReload();
  await page.reload();
  await expect(page.getByText('Persistent Local Note')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Все задачи' })).toBeVisible();

  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Delayed Pending Issue');
  await page.getByLabel('Репозиторий').selectOption('acme/repo');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await postStarted;
  await expect(
    page.locator('.task-row.pending-task', { hasText: 'Delayed Pending Issue' }),
  ).toBeVisible();
  await expect(page.locator('.task-row.pending-task', { hasText: '#-1' })).toHaveCount(0);

  releasePost();
  await expect(page.locator('.task-row', { hasText: 'Delayed Pending Issue' })).toBeVisible();
  await expect(
    page.locator('.task-row.pending-task', { hasText: 'Delayed Pending Issue' }),
  ).toHaveCount(0);

  await unregisterWorkerForMockedReload();
  await page.reload();
  await expect(page.getByText('Persistent Local Note')).toBeVisible();
  expect(badResponses).toEqual([]);
  expect(rootAssetRequests).toEqual([]);
});

test('production keeps a failed pending Issue visible and allows atomic cancellation', async ({
  page,
}) => {
  postMode = 'validation';
  await page.goto('./');
  await expect(page.getByText('Prod Fox')).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Invalid production pending');
  await page.getByLabel('Репозиторий').selectOption('acme/repo');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await postStarted;

  const pending = page.locator('.task-row.pending-task', {
    hasText: 'Invalid production pending',
  });
  await expect(pending).toBeVisible();
  await pending.click();
  await expect(
    page.getByLabel('Панель задачи').getByText(/Ошибка данных GitHub \(422\)/),
  ).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Отменить операцию' }).click();
  await expect(pending).toHaveCount(0);
});

test('production handles repository 401 as logout without losing local data', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByText('Prod Fox')).toBeVisible();
  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Survives 401');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByText('Survives 401')).toBeVisible();

  issuesMode = 'unauthorized';
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await expect(page.getByText(/Сессия GitHub истекла/)).toBeVisible();
  await expect(page.getByText('Survives 401')).toBeVisible();
  expect(
    await page.evaluate(() => sessionStorage.getItem('kitsuflow.github.access-token')),
  ).toBeNull();
});

test('production converts an opened local-note tab and panel to the real Issue', async ({
  page,
}) => {
  postMode = 'immediate-success';
  await page.goto('./');
  await expect(page.getByText('Prod Fox')).toBeVisible();
  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Opened conversion');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const noteRow = page.locator('.task-row', { hasText: 'Opened conversion' });
  await noteRow.dblclick();
  await expect(page.getByRole('tab', { name: 'Заметка' })).toBeVisible();

  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();
  await page.getByRole('button', { name: 'Превратить в Issue' }).click();
  await page.getByLabel('Конвертация в Issue').getByLabel('Репозиторий').selectOption('acme/repo');
  await page.getByRole('button', { name: 'Создать Issue' }).click();

  await expect(page.getByRole('tab', { name: /repo #11/ })).toBeVisible();
  await expect(page.getByText('Задача не найдена')).toHaveCount(0);
  await expect(page.getByLabel('Название Issue')).toHaveValue('Opened conversion');
});

test('production stale GET cannot remove an Issue created after the request started', async ({
  page,
}) => {
  postMode = 'immediate-success';
  await page.goto('./');
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  issuesMode = 'delayed-stale';
  await page.getByLabel('Обновить').click();
  await issueGetStarted;
  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Created during stale GET');
  await page.getByLabel('Репозиторий').selectOption('acme/repo');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByText('Created during stale GET')).toBeVisible();
  releaseIssueGet();
  await expect(page.getByText('Production Issue 10')).toBeVisible();
  await expect(page.getByText('Created during stale GET')).toBeVisible();
});

test('production preserves successful repositories during a partial refresh failure', async ({
  page,
}) => {
  repositoriesMode = 'partial';
  await page.goto('./');
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByText('acme/broken', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  await expect(page.getByText('Production Issue 10')).toBeVisible();
  await expect(page.getByText(/acme\/broken: репозиторий не найден/)).toBeVisible();
});
