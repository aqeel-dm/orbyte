import type { OrbyteApi } from '../shared/types/api'

declare global {
  interface Window {
    orbyte: OrbyteApi
  }
}
export {}
