FROM node:12

# Create app directory
WORKDIR /usr/src/app

COPY . .

RUN yarn global add knex-migrator grunt-cli ember-cli

RUN yarn setup

EXPOSE 2368

RUN grunt dev
