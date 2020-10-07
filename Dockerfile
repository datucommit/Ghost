FROM node:12

# Create app directory
WORKDIR /usr/src/app

RUN yarn global add knex-migrator grunt-cli ember-cli

# copy admin client and install
COPY core/client/package.json core/client/package.json
COPY core/client/yarn.lock core/client/yarn.lock
RUN yarn --cwd "core/client" install

# copy ghost core and admin custom api and install
COPY package.json package.json
COPY yarn.lock yarn.lock
COPY admin-api-schema admin-api-schema
RUN yarn

COPY . .

EXPOSE 2368

#RUN grunt
RUN grunt prod
CMD ["yarn", "start"]
