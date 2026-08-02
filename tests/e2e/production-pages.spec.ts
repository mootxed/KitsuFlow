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

test.beforeEach(async ({ page }) => {
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
          ],
        },
      });
    if (url.pathname === '/repos/acme/repo/issues' && method === 'GET')
      return route.fulfill({ json: [issue(10, 'Production Issue 10')] });
    if (url.pathname === '/repos/acme/repo/issues' && method === 'POST')
      return route.fulfill({ status: 201, json: issue(11, 'Created Prod Issue') });
    if (url.pathname === '/repos/acme/repo/labels') return route.fulfill({ json: [] });
    if (url.pathname === '/repos/acme/repo/assignees') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { message: `Unhandled ${method} ${url.pathname}` } });
  });
});

test('production subpath page loads and manages workspace with pending issues', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Все задачи').first()).toBeVisible();

  // Create local task
  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Local Note Production');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByText('Local Note Production')).toBeVisible();

  // Select repo
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  // Quick create issue
  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Created Prod Issue');
  await page.getByLabel('Репозиторий').selectOption('acme/repo');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  // Verify created issue appears
  await expect(page.getByText('Created Prod Issue')).toBeVisible();
});
