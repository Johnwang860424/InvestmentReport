import { SiteCrawler } from '../core/types';
import { YuantaCrawler } from './yuanta';
import { KGICrawler } from './kgi';
import { CathayCrawler } from './cathay';
import { CapitalCrawler } from './capital';
import { FubonCrawler } from './fubon';
import { SinopacCrawler } from './sinopac';
import { EsunCrawler } from './esun';

/**
 * 所有已支援的網站爬蟲註冊清單
 */
export const SITES_REGISTRY: Record<string, () => SiteCrawler> = {
  yuanta: () => new YuantaCrawler(),
  kgi: () => new KGICrawler(),
  cathay: () => new CathayCrawler(),
  capital: () => new CapitalCrawler(),
  fubon: () => new FubonCrawler(),
  sinopac: () => new SinopacCrawler(),
  esun: () => new EsunCrawler(),
};

/**
 * 取得指定站點的爬蟲實例
 */
export function getCrawler(siteId: string): SiteCrawler | null {
  const factory = SITES_REGISTRY[siteId.toLowerCase()];
  return factory ? factory() : null;
}

/**
 * 取得所有已註冊的爬蟲清單
 */
export function getAllCrawlers(): SiteCrawler[] {
  return Object.values(SITES_REGISTRY).map(factory => factory());
}
