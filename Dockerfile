FROM node:12

# Create app directory
WORKDIR /usr/src/app

RUN yarn global add knex-migrator grunt-cli ember-cli

COPY . .

RUN yarn

RUN yarn --cwd "core/client" install

#RUN yarn setup
#RUN yarn start

EXPOSE 2368

RUN grunt
RUN grunt prod
CMD ["yarn", "start"]
