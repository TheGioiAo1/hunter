import { generate } from 'openapi-typescript-codegen';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const services = [
  { name: 'app', url: 'https://api-app.gbox.co/swagger/v1/swagger.json' },
  { name: 'auth', url: 'https://api-auth.gbox.co/swagger/v1/swagger.json' },
  { name: 'cdn', url: 'https://api-cdn.gbox.co/swagger/v1/swagger.json' },
  { name: 'customer', url: 'https://api-customer.gbox.co/swagger/v1/swagger.json' },
  { name: 'email', url: 'https://api-email.gbox.co/swagger/v1/swagger.json' },
  { name: 'layout', url: 'https://api-layout.gbox.co/swagger/v1/swagger.json' },
  { name: 'order', url: 'https://api-order.gbox.co/swagger/v1/swagger.json' },
  { name: 'page', url: 'https://api-page.gbox.co/swagger/v1/swagger.json' },
  { name: 'payment', url: 'https://api-payment.gbox.co/swagger/v1/swagger.json' },
  { name: 'product', url: 'https://api-product.gbox.co/swagger/v1/swagger.json' },
  { name: 'shipping', url: 'https://api-shipping.gbox.co/swagger/v1/swagger.json' },
  { name: 'shop', url: 'https://api-shop.gbox.co/swagger/v1/swagger.json' },
];

async function run() {
  for (const service of services) {
    console.log(`Generating client for ${service.name}...`);
    try {
      await generate({
        input: service.url,
        output: path.resolve(__dirname, `../src/${service.name}`),
        httpClient: 'axios',
        useOptions: true,
      });
    } catch (e) {
      console.error(`Failed to generate client for ${service.name}:`, e);
    }
  }
}

run();
