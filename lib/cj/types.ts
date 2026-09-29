// Shapes of CJ API V2 responses. Fields are optional where CJ's documentation marks them
// nullable or where they differ between endpoints; normalize.ts reads them defensively and
// the full raw payload is always stored alongside the normalized record.

export interface CjEnvelope<T> {
  code: number;
  result: boolean;
  message: string;
  data: T;
  requestId?: string;
  success?: boolean;
}

export interface CjTokenData {
  openId?: number | string;
  accessToken: string;
  accessTokenExpiryDate?: string;
  refreshToken?: string;
  refreshTokenExpiryDate?: string;
  createDate?: string;
}

/** One product row from GET /product/listV2 (data.content[].productList[]). */
export interface CjListV2Product {
  id: string; // PID
  nameEn?: string;
  sku?: string;
  spu?: string;
  bigImage?: string;
  sellPrice?: string | number;
  nowPrice?: string | number;
  discountPrice?: string | number;
  listedNum?: number;
  categoryId?: string;
  threeCategoryName?: string;
  twoCategoryName?: string;
  oneCategoryName?: string;
  warehouseInventoryNum?: number;
  totalVerifiedInventory?: number;
  totalUnVerifiedInventory?: number;
  deliveryCycle?: string | number;
  isVideo?: number;
  variantKeyEn?: string;
  [key: string]: unknown;
}

export interface CjListV2Data {
  pageSize?: number;
  pageNumber?: number;
  totalRecords?: number;
  totalPages?: number;
  content?: Array<{ productList?: CjListV2Product[]; keyWord?: string; [key: string]: unknown }>;
  // Older/alternate shape, tolerated.
  list?: CjListV2Product[];
  total?: number;
}

export interface CjVariant {
  vid: string;
  pid: string;
  variantNameEn?: string | null;
  variantName?: string | null;
  variantSku: string;
  variantImage?: string | null;
  variantKey?: string | null;
  variantUnit?: string | null;
  variantProperty?: string | null;
  variantStandard?: string | null;
  variantLength?: number | null;
  variantWidth?: number | null;
  variantHeight?: number | null;
  variantVolume?: number | null;
  variantWeight?: number | null;
  variantSellPrice?: number | string | null;
  variantSugSellPrice?: number | string | null;
  createTime?: string | null;
  [key: string]: unknown;
}

/** GET /product/query data. */
export interface CjProductDetail {
  pid: string;
  productNameEn?: string;
  productName?: string | string[];
  productSku: string;
  productImage?: string; // may be a URL or a JSON-encoded array of URLs
  productImageSet?: string[];
  productWeight?: number | string;
  productKeyEn?: string; // e.g. "Color-Size"
  productUnit?: string;
  categoryName?: string;
  description?: string;
  sellPrice?: number | string;
  variants?: CjVariant[];
  [key: string]: unknown;
}

/** One warehouse row from GET /product/stock/queryByVid. */
export interface CjStockEntry {
  vid?: string;
  areaId?: number | string;
  areaEn?: string;
  countryCode?: string;
  countryNameEn?: string;
  totalInventoryNum?: number;
  cjInventoryNum?: number;
  factoryInventoryNum?: number;
  storageNum?: number;
  [key: string]: unknown;
}
