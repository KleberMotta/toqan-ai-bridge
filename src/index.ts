import { buildServer } from "./server";
const PORT = Number(process.env.PORT || 8000);

const server = buildServer();

server.listen({ port: PORT, host: "0.0.0.0" })
  .then(() => console.log(`listening at ${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
