declare module "mime-types" {
  export function lookup(ext: string): string | false;
  export function contentType(type: string): string | false;
  export function extension(type: string): string | false;
  export function charset(type: string): string | false;
}
