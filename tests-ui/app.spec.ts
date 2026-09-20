import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('tutorial renders and is accessible', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('workflow is accessible and tenant switch changes rows', async ({ page }) => {
  await page.goto('/app.html');
  await expect(page.getByText('Ship the search endpoint')).toBeVisible();
  await page.getByLabel('Identity').selectOption('eve');
  await expect(page.getByText('Confidential launch')).toBeVisible();
  await expect(page.getByText('Ship the search endpoint')).not.toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test('approval dialog cancels safely', async ({ page }) => {
  await page.goto('/app.html');
  await page.getByRole('button', { name: 'Run the workflow' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});
