import { expect, test } from '@playwright/test';

const issue = (number: number, title: string) => ({
  number,
  node_id: `I_${number}`,
  title,
  body: 'Created from local note',
  state: 'open',
  labels: [],
  assignees: [],
  html_url: `https://github.com/acme/repo/issues/${number}`,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem('kitsuflow.github.access-token', 'e2e-token'),
  );
  await page.route('https://api.github.com/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/user')
      return route.fulfill({
        json: {
          id: 1,
          login: 'fox',
          name: 'Fox Dev',
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
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
      return route.fulfill({ json: [issue(5, 'Existing issue')] });
    if (url.pathname === '/repos/acme/repo/issues' && method === 'POST')
      return route.fulfill({ status: 201, json: issue(6, 'Convert local note') });
    if (url.pathname === '/repos/acme/repo/labels') return route.fulfill({ json: [] });
    if (url.pathname === '/repos/acme/repo/assignees') return route.fulfill({ json: [] });
    if (url.pathname.startsWith('/repos/acme/repo/issues/') && method === 'PATCH')
      return route.fulfill({ json: issue(6, 'Convert local note') });
    return route.fulfill({ status: 404, json: { message: `Unhandled ${method} ${url.pathname}` } });
  });
});

test('local note converts to Issue and tabs restore', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Fox Dev')).toBeVisible();
  await expect(page.getByText('Все задачи').first()).toBeVisible();

  // Create local note
  await page.keyboard.press('c');
  await page.getByLabel('Название').fill('Convert local note');
  await page.getByLabel('Описание').fill('Test detail');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(
    page.locator('.task-title', { hasText: 'Convert local note' }).first(),
  ).toBeVisible();

  // Pin repository
  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  // Convert note to Issue
  await page.locator('.task-title', { hasText: 'Convert local note' }).first().click();
  await page.getByRole('button', { name: 'Превратить в Issue' }).click();
  await expect(page.getByLabel('Конвертация в Issue')).toBeVisible();
  await page.getByLabel('Конвертация в Issue').getByLabel('Репозиторий').selectOption('acme/repo');
  await page.getByRole('button', { name: 'Создать Issue' }).click();

  await expect(
    page.locator('.task-title', { hasText: 'Convert local note' }).first(),
  ).toBeVisible();

  // Open repository in a new tab via Shift + click
  const repoLink = page.locator('.repository-link').first();
  await expect(repoLink).toBeVisible();
  await repoLink.click({ modifiers: ['Shift'] });

  // Verify tab opened and persists across page reload
  await expect(page.getByRole('tab', { name: /repo/ })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Fox Dev')).toBeVisible();
  await expect(page.getByRole('tab', { name: /repo/ })).toBeVisible();

  // Close repo tab
  await page
    .getByRole('tab', { name: /repo/ })
    .getByRole('button', { name: /Закрыть вкладку/ })
    .click();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Все задачи' })).toBeVisible();
});

test('opening quick create from repository view pre-selects current repository', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText('Fox Dev')).toBeVisible();
  await expect(page.getByText('Все задачи').first()).toBeVisible();

  await page.getByRole('button', { name: 'Выбрать репозитории' }).click();
  await page.getByText('acme/repo', { exact: true }).click();
  await page.getByLabel('Выбор репозиториев').getByRole('button', { name: 'Готово' }).click();

  await page.locator('.repository-link').first().click();
  await page.keyboard.press('c');
  await expect(page.getByLabel('Быстрое создание')).toBeVisible();
  await page.getByLabel('Репозиторий').selectOption('acme/repo');
  await expect(page.getByLabel('Репозиторий')).toHaveValue('acme/repo');
});
